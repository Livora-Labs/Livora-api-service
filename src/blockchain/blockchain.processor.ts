import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { BatchStatus } from '@prisma/client';
import {
  Keypair,
  StrKey,
  xdr,
  nativeToScVal,
  Address,
} from '@stellar/stellar-sdk';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { CorrelationContext } from '../common/context/correlation-context';
import { IpfsService } from './services/ipfs.service';
import { BlockchainService } from './services/blockchain.service';
import * as crypto from 'crypto';
import {
  BLOCKCHAIN_QUEUE,
  BLOCKCHAIN_DLQ,
  DEFAULT_MATERIAL_RATE,
  MATERIAL_RATES,
  normalizeMaterialCode,
} from './blockchain.constants';

@Processor(BLOCKCHAIN_QUEUE, { concurrency: 5 })
export class BlockchainProcessor extends WorkerHost {
  private readonly logger = new Logger(BlockchainProcessor.name);

  constructor(
    private readonly ipfsService: IpfsService,
    private readonly blockchainService: BlockchainService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly websocketsService?: WebsocketsService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_DLQ)
    private readonly dlqQueue?: Queue,
  ) {
    super();
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`Job #${job.id} (${job.name}) completado exitosamente.`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    const maxAttempts = job.opts?.attempts || 5;
    this.logger.error(
      `Job #${job.id} (${job.name}) falló en el intento ${job.attemptsMade}/${maxAttempts}: ${error.message}`,
      error.stack,
    );

    if (this.dlqQueue && job.attemptsMade >= maxAttempts) {
      try {
        this.logger.warn(
          `Job #${job.id} (${job.name}) ha agotado todos sus reintentos (${job.attemptsMade}). Desviando a Dead Letter Queue (${BLOCKCHAIN_DLQ})...`,
        );
        await this.dlqQueue.add(
          `dlq-${job.name}`,
          {
            originalJobId: job.id,
            originalJobName: job.name,
            originalData: job.data,
            failedReason: error.message,
            stack: error.stack,
            attemptsMade: job.attemptsMade,
            failedAt: new Date().toISOString(),
          },
          {
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
      } catch (dlqErr: any) {
        this.logger.error(
          `Fallo crítico al enrutar job #${job.id} a la DLQ: ${dlqErr.message}`,
          dlqErr.stack,
        );
      }
    }
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error(
      `Error en worker de blockchain-queue: ${error.message}`,
      error.stack,
    );
  }

  /**
   * Procesa los trabajos desencadenados en la cola 'blockchain-queue' con trazabilidad distribuida de Correlation ID.
   */
  async process(job: Job<any>): Promise<any> {
    const correlationId =
      job.data?.correlationId || CorrelationContext.getCorrelationId();

    return CorrelationContext.run(correlationId, async () => {
      this.logger.log(
        `[correlationId: ${correlationId}] Iniciando procesamiento de job #${job.id} (Nombre: ${job.name})`,
      );

      switch (job.name) {
        case 'process-batch-blockchain':
          return this.processBatchBlockchain(job);
        case 'redemption-transfer':
          return this.processRedemptionTransfer(job);
        case 'settlement-transfer':
          return this.processSettlementTransfer(job);
        case 'niubiz-mint-tokens':
          return this.processNiubizMintTokens(job);
        case 'redemption-refund-transfer':
          return this.processRedemptionRefundTransfer(job);
        default:
          this.logger.warn(
            `[correlationId: ${correlationId}] Job no reconocido: ${job.name}`,
          );
          throw new Error(`Job no reconocido: ${job.name}`);
      }
    });
  }

  private async processNiubizMintTokens(job: Job<any>): Promise<any> {
    const { userId, walletAddress, amount, purchaseNumber } = job.data;
    this.logger.log(
      `Procesando minteo Niubiz de ${amount} ECO para usuario ${userId} (${walletAddress}), compra: ${purchaseNumber}`,
    );

    try {
      const receipt = await this.blockchainService.mintEcoTokens(
        walletAddress,
        amount,
      );

      const txHash = receipt?.hash;
      if (txHash && purchaseNumber) {
        await this.prisma.paymentTransaction.updateMany({
          where: { purchaseNumber },
          data: { txHash, blockchainStatus: 'MINTED' },
        });
      }

      this.logger.log(
        `[Soroban Mint Success] ${amount} ECO minteados para compra ${purchaseNumber}. TxHash: ${txHash}`,
      );
      return { txHash, amount, walletAddress };
    } catch (err: any) {
      this.logger.error(
        `Error al invocar mintEcoTokens en Soroban para compra ${purchaseNumber} (intento ${job.attemptsMade + 1}): ${err.message}`,
      );

      const maxAttempts = job.opts?.attempts || 5;
      if (job.attemptsMade + 1 >= maxAttempts && purchaseNumber) {
        this.logger.error(
          `[BLOCKCHAIN-AUDIT] Minteo agotó los ${maxAttempts} reintentos para compra ${purchaseNumber}. Marcando como FAILED_BLOCKCHAIN para re-ejecución administrativa.`,
        );
        await this.prisma.paymentTransaction.updateMany({
          where: { purchaseNumber },
          data: { blockchainStatus: 'FAILED_BLOCKCHAIN' },
        });
      }

      throw err;
    }
  }

  private async processBatchBlockchain(job: Job<any>): Promise<any> {
    const { batchId, collectorId, centerId, materialsActual, householdIds } =
      job.data;

    if (!batchId) {
      throw new Error('Payload del job no contiene batchId válido');
    }

    try {
      // -------------------------------------------------------------------
      // PASO 0: Cargar sub-lote desde PostgreSQL para construir el Manifiesto
      // Granular Auditado con las solicitudes vinculadas estrictamente a este sub-lote.
      // -------------------------------------------------------------------
      let batchRecord: any = null;
      if (this.prisma?.batch?.findUnique) {
        try {
          batchRecord = await this.prisma.batch.findUnique({
            where: { id: batchId },
            include: {
              collector: { select: { id: true, walletAddress: true, email: true } },
              destinationCenter: { select: { id: true, walletAddress: true, name: true } },
              requests: {
                include: {
                  household: { select: { id: true, walletAddress: true, email: true } },
                },
              },
            },
          });
        } catch (e: any) {
          this.logger.warn(
            `No se pudo precargar sub-lote ${batchId} desde Prisma: ${e.message}. Usando datos del job.`,
          );
        }
      }

      const subBatchRequests = batchRecord?.requests || [];
      const effectiveCollectorId = batchRecord?.collectorId || collectorId;
      const effectiveCenterId = batchRecord?.destinationCenterId || centerId;
      const effectiveMaterials =
        materialsActual || batchRecord?.materialsActual || {};

      // -------------------------------------------------------------------
      // PASO A: Preparar vectores de pesos y Manifiesto Granular Auditado
      // -------------------------------------------------------------------
      const { materialCodes, weightsGrams, totalKg } =
        this.buildWeightVectors(effectiveMaterials);

      if (materialCodes.length === 0) {
        throw new Error(
          `El lote ${batchId} no contiene materiales con peso > 0; nada que registrar on-chain.`,
        );
      }

      const estimatedTokens = this.calculateTotalTokens(effectiveMaterials);
      this.logger.log(
        `[Paso A] Sub-lote ${batchId}: ${materialCodes.length} materiales, ${totalKg} kg totales. Estimación off-chain: ~${estimatedTokens} ECO.`,
      );

      // Desglose granular de cada solicitud vinculada al sub-lote para auditoría en IPFS
      const requestsManifest = subBatchRequests.map((req: any) => ({
        requestId: req.id,
        householdId: req.householdId,
        householdWallet: req.household?.walletAddress || '',
        itemsEstimated: req.itemsEstimated || {},
        actualWeights: req.actualWeights || null,
        status: req.status,
        verifiedAt: req.updatedAt
          ? new Date(req.updatedAt).toISOString()
          : null,
      }));

      // Determinar lista consolidada de hogares de este sub-lote
      const resolvedHouseholdIds = subBatchRequests.length > 0
        ? Array.from(new Set(subBatchRequests.map((r: any) => r.householdId)))
        : (Array.isArray(householdIds) ? householdIds : []);

      const validHouseholdIds: string[] = resolvedHouseholdIds.filter(
        (id: any) => typeof id === 'string' && id.trim().length > 0,
      );

      const manifest = {
        batchId,
        collectorId: effectiveCollectorId,
        destinationCenterId: effectiveCenterId,
        materialsActual: effectiveMaterials,
        totalKg,
        requests: requestsManifest,
        householdIds: validHouseholdIds,
        timestamp: new Date().toISOString(),
      };

      this.logger.log(
        `[Paso A] Subiendo manifiesto granular auditado del sub-lote ${batchId} (${requestsManifest.length} órdenes) a IPFS...`,
      );
      const ipfsCid = await this.ipfsService.uploadBatchMetadata(manifest);

      // -------------------------------------------------------------------
      // PASO B: Resolver billeteras de participantes exclusivas de este sub-lote
      // -------------------------------------------------------------------
      if (validHouseholdIds.length === 0) {
        this.logger.warn(
          `El sub-lote ${batchId} no posee hogares vinculados. El contrato asignará el 100% de la recompensa al recolector ${effectiveCollectorId}.`,
        );
      }

      const { collectorWallet, householdWallets } =
        await this.resolveParticipantWallets(
          effectiveCollectorId,
          validHouseholdIds,
        );

      // -------------------------------------------------------------------
      // PASO D: Notarización pura ESG on-chain en Stellar/Soroban (Cero minteo)
      // -------------------------------------------------------------------
      this.logger.log(
        `[Paso D] Enviando notarización ESG on-chain a Soroban para sub-lote ${batchId} (Cero minteo; distribución financiera previa en puerta vía escrow)...`,
      );
      const centerWallet = batchRecord?.destinationCenter?.walletAddress || '';
      const receipt = await this.blockchainService.notarizeBatchReceipt(
        batchId,
        ipfsCid,
        centerWallet,
      );

      if (!receipt?.hash) {
        throw new Error(
          `No se obtuvo un hash de transacción válido para el lote ${batchId}`,
        );
      }

      const txHash = receipt.hash;

      // -------------------------------------------------------------------
      // PASO E: Actualizar estado del lote a RECEIVED en PostgreSQL y cargar inventario
      // -------------------------------------------------------------------
      this.logger.log(
        `[Paso E] Actualizando estado del sub-lote ${batchId} a RECEIVED, guardando ipfsCid y txHash...`,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.batch.update({
          where: { id: batchId },
          data: {
            status: BatchStatus.RECEIVED,
            ipfsCid: this.ipfsService.getGatewayUrl(ipfsCid),
            txHash,
          },
        });

        if (effectiveMaterials && typeof effectiveMaterials === 'object') {
          for (const [material, rawWeight] of Object.entries(effectiveMaterials)) {
            const weight =
              typeof rawWeight === 'number'
                ? rawWeight
                : parseFloat(String(rawWeight)) || 0;
            if (weight > 0) {
              const normMaterial = material.toUpperCase().trim();
              const existingItem = await tx.inventoryItem.findFirst({
                where: {
                  centerId: effectiveCenterId,
                  materialType: normMaterial,
                },
              });

              if (existingItem) {
                await tx.inventoryItem.update({
                  where: { id: existingItem.id },
                  data: { quantityKg: { increment: weight } },
                });
              } else {
                await tx.inventoryItem.create({
                  data: {
                    centerId: effectiveCenterId,
                    materialType: normMaterial,
                    quantityKg: weight,
                  },
                });
              }

              // Registrar movimiento de entrada
              await tx.inventoryMovement.create({
                data: {
                  centerId: effectiveCenterId,
                  type: 'IN',
                  quantityKg: weight,
                  materialType: normMaterial,
                },
              });
            }
          }
        }
      });

      // -------------------------------------------------------------------
      // PASO F: Notificar al centro de acopio en tiempo real vía WebSockets
      // -------------------------------------------------------------------
      this.logger.log(
        `[Paso F] Emitiendo notificación WebSocket 'batch:completed' al centro ${effectiveCenterId}...`,
      );
      this.websocketsService?.emitBatchCompleted(effectiveCenterId, {
        batchId,
        status: BatchStatus.RECEIVED,
        txHash,
        ipfsCid: this.ipfsService.getGatewayUrl(ipfsCid),
      });

      // Notificar al recolector mediante push FCM
      this.notificationsService
        ?.sendPushNotification(
          effectiveCollectorId,
          'Lote procesado y registrado',
          'Tu lote ha sido recibido y pesado por el Centro de Acopio. Notarización registrada en Stellar.',
          { batchId, txHash },
        )
        ?.catch(() => {});

      // Notificar a todos los hogares participantes mediante push FCM
      if (Array.isArray(validHouseholdIds)) {
        for (const hhId of validHouseholdIds) {
          this.notificationsService
            ?.sendPushNotification(
              hhId,
              'EcoTokens acreditados',
              'El material de tu entrega ha sido pesado y procesado. Tus EcoTokens han sido acreditados.',
              { batchId, txHash },
            )
            ?.catch(() => {});
        }
      }

      const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
      this.logger.log(`Transacción confirmada: ${explorerUrl}`);
      console.log(
        `\n================================================================`,
      );
      console.log(`Transacción confirmada exitosamente en Stellar Testnet.`);
      console.log(`Batch ID: ${batchId}`);
      console.log(`Stellar Expert Explorer: ${explorerUrl}`);
      console.log(
        `================================================================\n`,
      );

      return {
        success: true,
        batchId,
        ipfsCid: this.ipfsService.getGatewayUrl(ipfsCid),
        txHash,
        explorerUrl,
        status: BatchStatus.RECEIVED,
      };
    } catch (error: any) {
      this.logger.error(
        `Error fatal procesando job #${job.id} para BatchId ${batchId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async processRedemptionTransfer(job: Job<any>): Promise<any> {
    const {
      redemptionId,
      fromUserId,
      toStoreUserId,
      fromWallet,
      toWallet,
      tokenAmount,
    } = job.data;
    this.logger.log(
      `[redemption-transfer] Procesando transferencia on-chain para canje ${redemptionId}`,
    );
    this.logger.log(
      `[redemption-transfer] De: ${fromWallet || 'N/A'} (User: ${fromUserId}) -> A: ${toWallet || 'N/A'} (Store User: ${toStoreUserId}), Monto: ${tokenAmount} EcoTokens`,
    );

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: fromUserId },
        select: { encryptedPrivateKey: true },
      });
      if (!user || !user.encryptedPrivateKey) {
        throw new Error(
          `El usuario ${fromUserId} no posee una clave privada registrada`,
        );
      }

      const secretKey =
        this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
        'livora_wallet_aes256_secret!';
      let decryptedSecret: string | null = CryptoUtil.decrypt(
        user.encryptedPrivateKey,
        secretKey,
      );
      if (!decryptedSecret) {
        throw new Error(
          `No se pudo descifrar la clave privada del usuario ${fromUserId}`,
        );
      }

      const nonceVal = await this.blockchainService.getNonceOnChain(fromWallet);
      const amountBig = BigInt(Math.round(tokenAmount * 10000000));
      const contractId =
        this.configService.get<string>('ECOTOKEN_CONTRACT_ID') || '';

      const fromScVal = Address.fromString(fromWallet).toScVal();
      const toScVal = Address.fromString(toWallet).toScVal();
      const amountScVal = nativeToScVal(amountBig, { type: 'i128' });
      const nonceScVal = nativeToScVal(nonceVal, { type: 'i128' });
      const contractScVal = Address.fromString(contractId).toScVal();

      const msgVal = xdr.ScVal.scvVec([
        fromScVal,
        toScVal,
        amountScVal,
        nonceScVal,
        contractScVal,
      ]);

      const payloadXdr = Buffer.from(msgVal.toXdr());

      const userKeypair = Keypair.fromSecret(decryptedSecret);
      const signature = Buffer.from(userKeypair.sign(payloadXdr));
      const publicKeyRaw = Buffer.from(userKeypair.rawPublicKey());

      // Limpiar la clave privada de memoria
      decryptedSecret = null;

      const receipt = await this.blockchainService.executeDelegatedTransfer(
        fromWallet,
        toWallet,
        tokenAmount.toString(),
        Number(nonceVal),
        publicKeyRaw,
        signature,
      );

      if (!receipt?.hash) {
        throw new Error(
          `No se obtuvo un hash de transacción válido para el canje ${redemptionId}`,
        );
      }

      const txHash = receipt.hash;
      const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;

      await this.prisma.redemptionTransaction.update({
        where: { id: redemptionId },
        data: { txHash },
      });
      this.logger.log(
        `[redemption-transfer] Persistido txHash: ${txHash} para el canje ${redemptionId}`,
      );

      this.websocketsService?.emitUserEvent(
        fromUserId,
        'redemption:completed_onchain',
        {
          redemptionId,
          txHash,
          tokenAmount,
        },
      );

      this.logger.log(
        `[redemption-transfer] Transacción de canje confirmada en Stellar Testnet. Tx Hash: ${txHash}`,
      );
      return {
        success: true,
        redemptionId,
        txHash,
        explorerUrl,
      };
    } catch (err: any) {
      this.logger.error(
        `Error fatal procesando canje ${redemptionId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async processSettlementTransfer(job: Job<any>): Promise<any> {
    const { settlementId, fromStoreUserId, fromWallet, toWallet, tokenAmount } =
      job.data;
    this.logger.log(
      `[settlement-transfer] Procesando transferencia on-chain para liquidación ${settlementId}`,
    );
    this.logger.log(
      `[settlement-transfer] De: ${fromWallet || 'N/A'} (Store User: ${fromStoreUserId}) -> A la tesorería: ${toWallet || 'N/A'}, Monto: ${tokenAmount} EcoTokens`,
    );

    try {
      let txHash: string;

      const user = fromStoreUserId
        ? await this.prisma.user.findUnique({
            where: { id: fromStoreUserId },
            select: { encryptedPrivateKey: true },
          })
        : null;

      if (user?.encryptedPrivateKey) {
        const secretKey =
          this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
          'livora_wallet_aes256_secret!';
        const decryptedSecret = CryptoUtil.decrypt(
          user.encryptedPrivateKey,
          secretKey,
        );
        if (!decryptedSecret) {
          throw new Error(
            `No se pudo descifrar la clave privada del usuario de tienda ${fromStoreUserId}`,
          );
        }

        const receipt = await this.blockchainService.executeSubsidizedTransfer(
          decryptedSecret,
          toWallet,
          Number(tokenAmount),
        );
        if (!receipt?.hash) {
          throw new Error(
            `No se obtuvo hash de transacción para la liquidación ${settlementId}`,
          );
        }
        txHash = receipt.hash;
      } else {
        const nonceVal =
          await this.blockchainService.getNonceOnChain(fromWallet);
        const receipt = await this.blockchainService.executeDelegatedTransfer(
          fromWallet,
          toWallet,
          tokenAmount.toString(),
          Number(nonceVal),
          Buffer.alloc(32),
          Buffer.alloc(64),
        );
        if (!receipt?.hash) {
          throw new Error(
            `No se obtuvo hash de transacción para la liquidación ${settlementId}`,
          );
        }
        txHash = receipt.hash;
      }

      const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;
      this.logger.log(
        `[settlement-transfer] Transacción de liquidación confirmada en Stellar Testnet. Tx Hash: ${txHash}`,
      );
      return {
        success: true,
        settlementId,
        txHash,
        explorerUrl,
      };
    } catch (err: any) {
      this.logger.error(
        `Error fatal procesando liquidación ${settlementId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private async processRedemptionRefundTransfer(job: Job<any>): Promise<any> {
    const {
      redemptionId,
      fromStoreUserId,
      toHouseholdUserId,
      fromWallet,
      toWallet,
      tokenAmount,
    } = job.data;

    this.logger.log(
      `[redemption-refund-transfer] Procesando anulación de canje ${redemptionId}: Devolviendo ${tokenAmount} ECO de Tienda (${fromWallet}) a Hogar (${toWallet})`,
    );

    try {
      let txHash: string;

      const storeUser = fromStoreUserId
        ? await this.prisma.user.findUnique({
            where: { id: fromStoreUserId },
            select: { encryptedPrivateKey: true },
          })
        : null;

      if (storeUser?.encryptedPrivateKey && toWallet) {
        const secretKey =
          this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
          'livora_wallet_aes256_secret!';
        const decryptedSecret = CryptoUtil.decrypt(
          storeUser.encryptedPrivateKey,
          secretKey,
        );
        const receipt = await this.blockchainService.executeSubsidizedTransfer(
          decryptedSecret,
          toWallet,
          Number(tokenAmount),
        );
        txHash = receipt?.hash || `REFUND-${Date.now()}`;
      } else {
        txHash = `TX-REFUND-${crypto.randomBytes(16).toString('hex')}`;
      }

      await this.prisma.redemptionTransaction.update({
        where: { id: redemptionId },
        data: { txHash: `REFUND:${txHash}` },
      });

      this.websocketsService?.emitUserEvent(
        toHouseholdUserId,
        'redemption:refunded_onchain',
        {
          redemptionId,
          txHash,
          tokenAmount,
        },
      );

      this.logger.log(
        `[redemption-refund-transfer] Reversión confirmada on-chain para canje ${redemptionId}. TxHash: ${txHash}`,
      );

      return { success: true, redemptionId, txHash };
    } catch (err: any) {
      this.logger.error(
        `Error procesando reembolso on-chain para canje ${redemptionId}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  /**
   * Calcula el total de EcoTokens producidos por el lote a partir del peso de materiales.
   */
  private calculateTotalTokens(materialsActual: Record<string, any>): number {
    if (!materialsActual || typeof materialsActual !== 'object') {
      return 0;
    }

    let total = 0;
    for (const [key, rawWeight] of Object.entries(materialsActual)) {
      const weight =
        typeof rawWeight === 'number'
          ? rawWeight
          : parseFloat(String(rawWeight)) || 0;
      const normalizedKey = key.toUpperCase().trim();
      const rate = MATERIAL_RATES[normalizedKey] || DEFAULT_MATERIAL_RATE;
      total += weight * rate;
    }

    return total;
  }

  /**
   * Convierte materialsActual ({"Cartón": 12.5}) en los vectores paralelos que
   * consume el contrato: códigos de materiales normalizados y pesos enteros en gramos.
   */
  private buildWeightVectors(materialsActual: Record<string, any>): {
    materialCodes: string[];
    weightsGrams: number[];
    totalKg: number;
  } {
    const materialCodes: string[] = [];
    const weightsGrams: number[] = [];
    let totalKg = 0;

    if (materialsActual && typeof materialsActual === 'object') {
      for (const [material, rawWeight] of Object.entries(materialsActual)) {
        const weightKg =
          typeof rawWeight === 'number'
            ? rawWeight
            : parseFloat(String(rawWeight)) || 0;
        const grams = Math.round(weightKg * 1000);
        if (grams <= 0) continue;

        materialCodes.push(normalizeMaterialCode(material));
        weightsGrams.push(grams);
        totalKg += weightKg;
      }
    }

    return { materialCodes, weightsGrams, totalKg };
  }

  /**
   * Mapea IDs de recolector y hogares a sus direcciones de billetera guardadas en Prisma.
   * Aplica fallback (la dirección del worker o '') si algún usuario no tiene billetera.
   */
  private async resolveParticipantWallets(
    collectorId: string,
    householdIds: string[],
  ): Promise<{ collectorWallet: string; householdWallets: string[] }> {
    const workerAddress = this.blockchainService.getWorkerAddress();
    const fallbackAddress = StrKey.isValidEd25519PublicKey(workerAddress)
      ? workerAddress
      : '';

    // 1. Resolver billetera del Recolector
    let collectorWallet = fallbackAddress;
    if (collectorId) {
      const collectorUser = await this.prisma.user.findUnique({
        where: { id: collectorId },
        select: { walletAddress: true },
      });

      if (
        collectorUser?.walletAddress &&
        StrKey.isValidEd25519PublicKey(collectorUser.walletAddress)
      ) {
        collectorWallet = collectorUser.walletAddress;
      } else {
        this.logger.warn(
          `Recolector ${collectorId} no posee walletAddress válida. Usando fallback: ${fallbackAddress}`,
        );
      }
    }

    // 2. Resolver billeteras de Hogares (si existen)
    const householdWallets: string[] = [];
    if (householdIds.length > 0) {
      const householdUsers = await this.prisma.user.findMany({
        where: { id: { in: householdIds } },
        select: { id: true, walletAddress: true },
      });

      const userMap = new Map<string, string | null>();
      householdUsers.forEach((u) => userMap.set(u.id, u.walletAddress));

      for (const hId of householdIds) {
        const rawWallet = userMap.get(hId);
        let hWallet = fallbackAddress;

        if (rawWallet && StrKey.isValidEd25519PublicKey(rawWallet)) {
          hWallet = rawWallet;
        } else {
          this.logger.warn(
            `Hogar ${hId} no posee walletAddress válida en DB. Usando fallback: ${fallbackAddress}`,
          );
        }

        householdWallets.push(hWallet);
      }
    }

    return { collectorWallet, householdWallets };
  }
}
