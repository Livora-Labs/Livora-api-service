import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { BlockchainService } from '../../blockchain/services/blockchain.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { VerifyPinDto } from '../dto/verify-pin.dto';
import { CryptoUtil } from '../../common/utils/crypto.util';
import { RewardCalculatorFactory } from '../factories/reward-calculator.factory';
import { CollectionsRepository } from '../repositories/collections.repository';
import {
  CollectorOwnershipStep,
  StateReadinessStep,
  BruteForceProtectionStep,
  PinMatchStep,
  WeightValidationStep,
} from '../pipeline/pin-verification-chain';

/**
 * Servicio de Verificación en Campo (PUCP Disoft - Chain of Responsibility + Strategy + Data Mapper)
 * Coordina la autenticación multifactor física en domicilio, liquidación de recompensas ecológicas
 * e interactúa con Soroban sin inflar el Blob de Collections.
 */
@Injectable()
export class CollectionVerificationService {
  private readonly logger = new Logger(CollectionVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: CollectionsRepository,
    private readonly rewardFactory: RewardCalculatorFactory,
    private readonly blockchainService: BlockchainService,
    private readonly notificationsService: NotificationsService,
    private readonly websocketsService: WebsocketsService,
    private readonly configService: ConfigService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row) return row;
    const { verificationPin, ...safe } = row;
    return safe as T;
  }

  async verifyPin(id: string, collectorId: string, dto: VerifyPinDto) {
    const lockKey = `lock:verify:pin:${id}`;
    if (this.redisService) {
      const acquired = await this.redisService.setNX(lockKey, '1', 30);
      if (!acquired) {
        throw new BadRequestException('Verificación en proceso, por favor espere');
      }
    }

    try {
      const collectionRequest = await this.prisma.collectionRequest.findUnique({
        where: { id },
        include: {
          household: true,
          collector: true,
        },
      });

      if (!collectionRequest) {
        throw new NotFoundException('Solicitud de recolección no encontrada');
      }

      // Ensamblaje y ejecución de la Cadena de Responsabilidad (PUCP Disoft - Chain of Resp)
      const ownershipStep = new CollectorOwnershipStep();
      const stateStep = new StateReadinessStep();
      const bruteForceStep = new BruteForceProtectionStep();
      const pinMatchStep = new PinMatchStep();
      const weightStep = new WeightValidationStep();

      ownershipStep
        .setNext(stateStep)
        .setNext(bruteForceStep)
        .setNext(pinMatchStep)
        .setNext(weightStep);

      await ownershipStep.handle({
        id,
        collectorId,
        submittedPin: dto.pin,
        actualWeights: dto.actualWeights,
        collectionRequest,
        redisService: this.redisService,
      });

      // Cálculo de recompensas mediante Patrón Estrategia (PUCP Disoft - Strategy Pattern)
      const actualWeights =
        dto.actualWeights && Object.keys(dto.actualWeights).length > 0
          ? dto.actualWeights
          : (collectionRequest.itemsEstimated as Record<string, number>) || {};

      const agreedRates =
        (collectionRequest.agreedRates as Record<string, number>) || {};
      const isDonation = collectionRequest.isDonation;

      const strategy = this.rewardFactory.getStrategy(isDonation);
      const calculation = strategy.calculate(actualWeights, agreedRates, isDonation);

      const hogarAmount = calculation.householdAmount;
      const treasuryAmount = calculation.treasuryAmount;

      const householdUser = collectionRequest.household;
      const collectorUser = collectionRequest.collector;
      const treasuryWallet =
        (this.configService &&
          this.configService.get<string>('LIVORA_TREASURY_WALLET')) ||
        this.blockchainService.getWorkerAddress();

      const encryptionKey =
        (this.configService &&
          (this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
            this.configService.get<string>('ENCRYPTION_KEY'))) ||
        (process.env.NODE_ENV === 'test'
          ? 'test_isolated_wallet_encryption_key_32c'
          : '');

      if (!encryptionKey && process.env.NODE_ENV !== 'test') {
        throw new Error(
          'CRITICAL SECURITY ERROR: WALLET_ENCRYPTION_KEY es obligatoria para transferencias delegadas.',
        );
      }

      let txHash: string | null = null;

      // Transferencia on-chain en Stellar Soroban
      if (!isDonation && householdUser?.walletAddress && hogarAmount > 0) {
        let creditedOnChain = false;
        const collectorVault = collectorUser
          ? await this.prisma.walletVault.findUnique({
              where: { userId: collectorUser.id },
            })
          : null;

        if (collectorVault?.encryptedPrivateKey && encryptionKey) {
          try {
            const privKey = CryptoUtil.decrypt(
              collectorVault.encryptedPrivateKey,
              encryptionKey,
            );
            const keypair = Keypair.fromSecret(privKey);
            const balStr = await this.blockchainService.getBalance(
              keypair.publicKey(),
            );
            if (parseFloat(balStr) >= hogarAmount) {
              const transferRes =
                await this.blockchainService.executeSubsidizedTransfer(
                  privKey,
                  householdUser.walletAddress,
                  hogarAmount,
                );
              txHash = transferRes?.hash || null;
              creditedOnChain = true;
            }
          } catch (err: any) {
            this.logger.warn(
              `Transferencia on-chain desde recolector omitida: ${err.message}. Acreditando vía Minter oficial.`,
            );
          }
        }

        // Si el recolector no tenía fondos on-chain, acuñar vía Minter oficial
        if (!creditedOnChain) {
          try {
            this.logger.log(
              `Acuñando ${hogarAmount} LIVOs hacia Hogar ${householdUser.walletAddress} vía Minter de Livora`,
            );
            const mintRes = await this.blockchainService.mintEcoTokens(
              householdUser.walletAddress,
              hogarAmount,
            );
            txHash = mintRes?.hash || null;
            creditedOnChain = true;
          } catch (err: any) {
            this.logger.error(
              `Error al acuñar LIVOs para el Hogar: ${err.message}`,
            );
          }
        }
      }

      // Comisión a Tesorería si recolector tiene fondos
      const collectorVaultForTreasury = collectorUser
        ? await this.prisma.walletVault.findUnique({
              where: { userId: collectorUser.id },
            })
          : null;

      if (
        collectorVaultForTreasury?.encryptedPrivateKey &&
        treasuryWallet &&
        treasuryAmount > 0 &&
        treasuryWallet !== collectorUser?.walletAddress &&
        encryptionKey
      ) {
        try {
          const privKey = CryptoUtil.decrypt(
            collectorVaultForTreasury.encryptedPrivateKey,
            encryptionKey,
          );
          const keypair = Keypair.fromSecret(privKey);
          const balStr = await this.blockchainService.getBalance(
            keypair.publicKey(),
          );
          if (parseFloat(balStr) >= treasuryAmount) {
            await this.blockchainService.executeSubsidizedTransfer(
              privKey,
              treasuryWallet,
              treasuryAmount,
            );
          }
        } catch (err: any) {
          this.logger.warn(`Transferencia a Tesorería omitida: ${err.message}`);
        }
      }

      // Obtener o crear sub-lote abierto (OPEN) usando el Repositorio (PUCP Disoft - Data Mapper)
      let targetBatchId = collectionRequest.batchId;
      if (!targetBatchId) {
        let openBatch = await this.repository.findOpenBatch(
          collectorId,
          collectionRequest.assignedCenterId || '',
        );

        if (!openBatch && collectionRequest.assignedCenterId) {
          openBatch = await this.repository.createOpenBatch(
            collectorId,
            collectionRequest.assignedCenterId,
          );
        }
        targetBatchId = openBatch ? openBatch.id : null;
      }

      // Ejecución de actualización atómica condicional anti-race condition
      const success = await this.repository.atomicCompleteRequest(
        id,
        targetBatchId,
        actualWeights,
        hogarAmount,
        txHash,
      );

      if (!success) {
        throw new BadRequestException(
          'La solicitud ya fue procesada o no está en estado ACCEPTED, EN_ROUTE o ARRIVED',
        );
      }

      const completed = await this.prisma.collectionRequest.findUnique({
        where: { id },
        include: {
          household: { select: { id: true, email: true, name: true } },
          assignedCenter: { select: { id: true, name: true, email: true } },
        },
      });

      // Purgar telemetría y metadatos de ruta en Redis
      if (this.redisService) {
        await Promise.all([
          this.redisService.del(`collection:active:${id}`).catch(() => {}),
          this.redisService.del(`collector:loc:${id}`).catch(() => {}),
          this.redisService.del(`route:collection:${id}`).catch(() => {}),
        ]);
      }

      const pushMessage = isDonation
        ? '¡Muchas gracias por tu donación ecológica! Tu impacto ambiental ha sido registrado positivamente en Livora.'
        : `Se han acreditado ${hogarAmount.toFixed(2)} LIVOs a tu billetera por tu material reciclado.`;

      this.notificationsService
        .sendPushNotification(
          collectionRequest.householdId,
          'Recolección completada con éxito',
          pushMessage,
          { requestId: id },
        )
        .catch(() => {});

      if (completed) {
        this.websocketsService.emitCollectionUpdated(this.stripPin(completed));
      }

      return completed!;
    } finally {
      if (this.redisService) {
        await this.redisService.del(lockKey);
      }
    }
  }
}
