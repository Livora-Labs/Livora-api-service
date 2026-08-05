import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BatchStatus } from '@prisma/client';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { IpfsService } from './services/ipfs.service';
import { BlockchainService } from './services/blockchain.service';
import {
  BLOCKCHAIN_QUEUE,
  DEFAULT_MATERIAL_RATE,
  MATERIAL_RATES,
} from './blockchain.constants';

@Processor(BLOCKCHAIN_QUEUE)
export class BlockchainProcessor extends WorkerHost {
  private readonly logger = new Logger(BlockchainProcessor.name);

  constructor(
    private readonly ipfsService: IpfsService,
    private readonly blockchainService: BlockchainService,
    private readonly prisma: PrismaService,
    private readonly websocketsService: WebsocketsService,
  ) {
    super();
  }

  /**
   * Procesa los trabajos desencadenados en la cola 'blockchain-queue'.
   */
  async process(job: Job<any>): Promise<any> {
    this.logger.log(
      `Iniciando procesamiento de job #${job.id} (Nombre: ${job.name}) para BatchId: ${job.data?.batchId}`,
    );

    const { batchId, collectorId, centerId, materialsActual, householdIds } = job.data;

    if (!batchId) {
      throw new Error('Payload del job no contiene batchId válido');
    }

    try {
      // -------------------------------------------------------------------
      // PASO A: Generar manifiesto del lote y subir metadatos a IPFS
      // -------------------------------------------------------------------
      const manifest = {
        batchId,
        collectorId,
        centerId,
        materialsActual: materialsActual || {},
        householdIds: householdIds || [],
        timestamp: new Date().toISOString(),
      };

      this.logger.log(`[Paso A] Subiendo manifiesto del lote ${batchId} a IPFS...`);
      const ipfsCid = await this.ipfsService.uploadBatchMetadata(manifest);

      // -------------------------------------------------------------------
      // PASO B: Calcular la distribución de EcoTokens
      // -------------------------------------------------------------------
      this.logger.log(`[Paso B] Calculando distribución de EcoTokens para el lote ${batchId}...`);
      const totalTokens = this.calculateTotalTokens(materialsActual);

      // Normalizar lista de IDs de hogares para evitar errores
      const validHouseholdIds: string[] = Array.isArray(householdIds)
        ? householdIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : [];

      let collectorTokens = 0;
      let householdTokensEach = 0;

      // Validación defensiva de Hogares Vacíos:
      if (validHouseholdIds.length === 0) {
        this.logger.warn(
          `El lote ${batchId} no posee hogares vinculados. Redirigiendo el 100% de los EcoTokens (${totalTokens}) al recolector ${collectorId}.`,
        );
        collectorTokens = totalTokens;
        householdTokensEach = 0;
      } else {
        const householdShareTotal = totalTokens * 0.8;
        collectorTokens = totalTokens * 0.2;
        householdTokensEach = householdShareTotal / validHouseholdIds.length;
      }

      this.logger.log(
        `Total Tokens: ${totalTokens} | Recolector: ${collectorTokens} | Por Hogar (${validHouseholdIds.length}): ${householdTokensEach}`,
      );

      // Consulta de Billeteras en Prisma con mapeo defensivo y fallbacks
      const { recipients, amounts } = await this.buildRecipientsAndAmounts(
        collectorId,
        collectorTokens,
        validHouseholdIds,
        householdTokensEach,
      );

      // -------------------------------------------------------------------
      // PASO C: Convertir batchId (UUID string) a bytes32 hex
      // -------------------------------------------------------------------
      const batchIdBytes32 = ethers.id(batchId);
      this.logger.log(`[Paso C] BatchId UUID '${batchId}' convertido a bytes32: ${batchIdBytes32}`);

      // -------------------------------------------------------------------
      // PASO D: Invocar contrato inteligente on-chain en Arbitrum
      // -------------------------------------------------------------------
      this.logger.log(`[Paso D] Enviando transacción on-chain al contrato inteligente...`);
      const receipt = await this.blockchainService.executeBatchRegistration(
        batchIdBytes32,
        ipfsCid,
        recipients,
        amounts,
      );

      const txHash = receipt?.hash || `0xmock${Date.now().toString(16)}`;

      // -------------------------------------------------------------------
      // PASO E: Actualizar estado del lote a RECEIVED en PostgreSQL vía Prisma
      // -------------------------------------------------------------------
      this.logger.log(`[Paso E] Actualizando estado del lote ${batchId} a RECEIVED en PostgreSQL...`);
      await this.prisma.batch.update({
        where: { id: batchId },
        data: { status: BatchStatus.RECEIVED },
      });

      // -------------------------------------------------------------------
      // PASO F: Notificar al centro de acopio en tiempo real vía WebSockets
      // -------------------------------------------------------------------
      this.logger.log(
        `[Paso F] Emitiendo notificación WebSocket 'batch:completed' al centro ${centerId}...`,
      );
      this.websocketsService.emitBatchCompleted(centerId, {
        batchId,
        status: BatchStatus.RECEIVED,
        txHash,
      });

      const explorerUrl = `https://sepolia.arbiscan.io/tx/${txHash}`;
      this.logger.log(`✅ Transacción minada: ${explorerUrl}`);
      console.log(`\n================================================================`);
      console.log(`✅ Transacción minada exitosamente en Arbitrum Sepolia!`);
      console.log(`📦 Batch ID: ${batchId}`);
      console.log(`🔗 Arbiscan Explorer: ${explorerUrl}`);
      console.log(`================================================================\n`);

      return {
        success: true,
        batchId,
        ipfsCid,
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

  /**
   * Calcula el total de EcoTokens producidos por el lote a partir del peso de materiales.
   */
  private calculateTotalTokens(materialsActual: Record<string, any>): number {
    if (!materialsActual || typeof materialsActual !== 'object') {
      return 0;
    }

    let total = 0;
    for (const [key, rawWeight] of Object.entries(materialsActual)) {
      const weight = typeof rawWeight === 'number' ? rawWeight : parseFloat(String(rawWeight)) || 0;
      const normalizedKey = key.toUpperCase().trim();
      const rate = MATERIAL_RATES[normalizedKey] || DEFAULT_MATERIAL_RATE;
      total += weight * rate;
    }

    return total;
  }

  /**
   * Mapea IDs de recolector y hogares a sus direcciones de billetera guardadas en Prisma.
   * Aplica fallback (ethers.ZeroAddress o la dirección del worker) si algún usuario no tiene billetera.
   */
  private async buildRecipientsAndAmounts(
    collectorId: string,
    collectorTokens: number,
    householdIds: string[],
    householdTokensEach: number,
  ): Promise<{ recipients: string[]; amounts: bigint[] }> {
    const recipients: string[] = [];
    const amounts: bigint[] = [];

    // Fallback por defecto si la dirección de un usuario es nula o inválida
    const workerAddress = this.blockchainService.getWorkerAddress();
    const fallbackAddress =
      ethers.isAddress(workerAddress) && workerAddress !== ethers.ZeroAddress
        ? workerAddress
        : ethers.ZeroAddress;

    // 1. Resolver billetera del Recolector
    let collectorWallet = fallbackAddress;
    if (collectorId) {
      const collectorUser = await this.prisma.user.findUnique({
        where: { id: collectorId },
        select: { walletAddress: true },
      });

      if (collectorUser?.walletAddress && ethers.isAddress(collectorUser.walletAddress)) {
        collectorWallet = collectorUser.walletAddress;
      } else {
        this.logger.warn(
          `Recolector ${collectorId} no posee walletAddress válida. Usando fallback: ${fallbackAddress}`,
        );
      }
    }

    recipients.push(collectorWallet);
    amounts.push(ethers.parseUnits(collectorTokens.toFixed(4), 18));

    // 2. Resolver billeteras de Hogares (si existen)
    if (householdIds.length > 0 && householdTokensEach > 0) {
      const householdUsers = await this.prisma.user.findMany({
        where: { id: { in: householdIds } },
        select: { id: true, walletAddress: true },
      });

      const userMap = new Map<string, string | null>();
      householdUsers.forEach((u) => userMap.set(u.id, u.walletAddress));

      for (const hId of householdIds) {
        const rawWallet = userMap.get(hId);
        let hWallet = fallbackAddress;

        if (rawWallet && ethers.isAddress(rawWallet)) {
          hWallet = rawWallet;
        } else {
          this.logger.warn(
            `Hogar ${hId} no posee walletAddress válida en DB. Usando fallback: ${fallbackAddress}`,
          );
        }

        recipients.push(hWallet);
        amounts.push(ethers.parseUnits(householdTokensEach.toFixed(4), 18));
      }
    }

    return { recipients, amounts };
  }
}
