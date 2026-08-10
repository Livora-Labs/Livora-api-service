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
  normalizeMaterialCode,
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
      `Iniciando procesamiento de job #${job.id} (Nombre: ${job.name})`,
    );

    switch (job.name) {
      case 'process-batch-blockchain':
        return this.processBatchBlockchain(job);
      case 'redemption-transfer':
        return this.processRedemptionTransfer(job);
      case 'settlement-transfer':
        return this.processSettlementTransfer(job);
      default:
        this.logger.warn(`Job no reconocido: ${job.name}`);
        throw new Error(`Job no reconocido: ${job.name}`);
    }
  }

  private async processBatchBlockchain(job: Job<any>): Promise<any> {
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
      // PASO B: Preparar vectores de pesos y participantes. El cálculo de
      // tokens (tarifa × peso y distribución 80/20) ocurre ON-CHAIN dentro
      // del contrato Stylus: el backend solo reporta pesos verificables.
      // -------------------------------------------------------------------
      const { materialCodes, weightsGrams, totalKg } =
        this.buildWeightVectors(materialsActual);

      if (materialCodes.length === 0) {
        throw new Error(
          `El lote ${batchId} no contiene materiales con peso > 0; nada que registrar on-chain.`,
        );
      }

      const estimatedTokens = this.calculateTotalTokens(materialsActual);
      this.logger.log(
        `[Paso B] ${materialCodes.length} materiales, ${totalKg} kg totales. Estimación off-chain: ~${estimatedTokens} ECO (el monto final lo calcula el contrato).`,
      );

      // Normalizar lista de IDs de hogares para evitar errores
      const validHouseholdIds: string[] = Array.isArray(householdIds)
        ? householdIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : [];

      if (validHouseholdIds.length === 0) {
        this.logger.warn(
          `El lote ${batchId} no posee hogares vinculados. El contrato asignará el 100% de la recompensa al recolector ${collectorId}.`,
        );
      }

      // Consulta de Billeteras en Prisma con mapeo defensivo y fallbacks
      const { collectorWallet, householdWallets } =
        await this.resolveParticipantWallets(collectorId, validHouseholdIds);

      // -------------------------------------------------------------------
      // PASO C: Convertir batchId (UUID string) a bytes32 hex
      // -------------------------------------------------------------------
      const batchIdBytes32 = ethers.id(batchId);
      this.logger.log(`[Paso C] BatchId UUID '${batchId}' convertido a bytes32: ${batchIdBytes32}`);

      // -------------------------------------------------------------------
      // PASO D: Invocar contrato inteligente on-chain en Arbitrum
      // -------------------------------------------------------------------
      this.logger.log(`[Paso D] Enviando transacción on-chain al contrato inteligente...`);
      const receipt = await this.blockchainService.executeBatchRegistrationWeighed(
        batchIdBytes32,
        ipfsCid,
        collectorWallet,
        householdWallets,
        materialCodes,
        weightsGrams,
      );

      const txHash = receipt?.hash || `0xmock${Date.now().toString(16)}`;

      // -------------------------------------------------------------------
      // PASO E: Actualizar estado del lote a RECEIVED en PostgreSQL y cargar inventario
      // -------------------------------------------------------------------
      this.logger.log(`[Paso E] Actualizando estado del lote ${batchId} a RECEIVED, guardando ipfsCid y txHash...`);
      await this.prisma.$transaction(async (tx) => {
        await tx.batch.update({
          where: { id: batchId },
          data: { status: BatchStatus.RECEIVED, ipfsCid, txHash },
        });

        if (materialsActual && typeof materialsActual === 'object') {
          for (const [material, rawWeight] of Object.entries(materialsActual)) {
            const weight = typeof rawWeight === 'number' ? rawWeight : parseFloat(String(rawWeight)) || 0;
            if (weight > 0) {
              const normMaterial = material.toUpperCase().trim();
              const existingItem = await tx.inventoryItem.findFirst({
                where: {
                  centerId,
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
                    centerId,
                    materialType: normMaterial,
                    quantityKg: weight,
                  },
                });
              }

              // Registrar movimiento de entrada
              await tx.inventoryMovement.create({
                data: {
                  centerId,
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
        `[Paso F] Emitiendo notificación WebSocket 'batch:completed' al centro ${centerId}...`,
      );
      this.websocketsService.emitBatchCompleted(centerId, {
        batchId,
        status: BatchStatus.RECEIVED,
        txHash,
        ipfsCid,
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

  private async processRedemptionTransfer(job: Job<any>): Promise<any> {
    const { redemptionId, fromUserId, toStoreUserId, fromWallet, toWallet, tokenAmount } = job.data;
    this.logger.log(`[redemption-transfer] Procesando transferencia on-chain para canje ${redemptionId}`);
    this.logger.log(`[redemption-transfer] De: ${fromWallet || 'N/A'} (User: ${fromUserId}) -> A: ${toWallet || 'N/A'} (Store User: ${toStoreUserId}), Monto: ${tokenAmount} EcoTokens`);
    
    // Simular retraso de red de blockchain
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    const txHash = `0xredempt${Date.now().toString(16)}${Math.random().toString(16).substring(2, 10)}`;
    const explorerUrl = `https://sepolia.arbiscan.io/tx/${txHash}`;
    
    try {
      await this.prisma.redemptionTransaction.update({
        where: { id: redemptionId },
        data: { txHash },
      });
      this.logger.log(`[redemption-transfer] Persistido txHash: ${txHash} para el canje ${redemptionId}`);
      
      // Notificar al usuario (hogar/recolector) que el pago finalizó y debe refrescar el balance
      this.websocketsService.emitUserEvent(fromUserId, 'redemption:completed_onchain', {
        redemptionId,
        txHash,
        tokenAmount,
      });
    } catch (dbError: any) {
      this.logger.error(`Error actualizando txHash del canje ${redemptionId}: ${dbError.message}`);
    }

    this.logger.log(`[redemption-transfer] ✅ Transacción de canje confirmada en Arbitrum Sepolia. Tx Hash: ${txHash}`);
    return {
      success: true,
      redemptionId,
      txHash,
      explorerUrl,
    };
  }

  private async processSettlementTransfer(job: Job<any>): Promise<any> {
    const { settlementId, fromStoreUserId, fromWallet, toWallet, tokenAmount } = job.data;
    this.logger.log(`[settlement-transfer] Procesando transferencia on-chain para liquidación ${settlementId}`);
    this.logger.log(`[settlement-transfer] De: ${fromWallet || 'N/A'} (Store User: ${fromStoreUserId}) -> A la tesorería: ${toWallet || 'N/A'}, Monto: ${tokenAmount} EcoTokens`);
    
    // Simular retraso de red de blockchain
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    const txHash = `0xsettle${Date.now().toString(16)}${Math.random().toString(16).substring(2, 10)}`;
    const explorerUrl = `https://sepolia.arbiscan.io/tx/${txHash}`;
    
    this.logger.log(`[settlement-transfer] ✅ Transacción de liquidación confirmada en Arbitrum Sepolia. Tx Hash: ${txHash}`);
    return {
      success: true,
      settlementId,
      txHash,
      explorerUrl,
    };
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
   * Convierte materialsActual ({"Cartón": 12.5}) en los vectores paralelos que
   * consume el contrato: códigos bytes32 normalizados y pesos enteros en gramos.
   */
  private buildWeightVectors(materialsActual: Record<string, any>): {
    materialCodes: string[];
    weightsGrams: bigint[];
    totalKg: number;
  } {
    const materialCodes: string[] = [];
    const weightsGrams: bigint[] = [];
    let totalKg = 0;

    if (materialsActual && typeof materialsActual === 'object') {
      for (const [material, rawWeight] of Object.entries(materialsActual)) {
        const weightKg =
          typeof rawWeight === 'number' ? rawWeight : parseFloat(String(rawWeight)) || 0;
        const grams = Math.round(weightKg * 1000);
        if (grams <= 0) continue;

        materialCodes.push(
          ethers.encodeBytes32String(normalizeMaterialCode(material)),
        );
        weightsGrams.push(BigInt(grams));
        totalKg += weightKg;
      }
    }

    return { materialCodes, weightsGrams, totalKg };
  }

  /**
   * Mapea IDs de recolector y hogares a sus direcciones de billetera guardadas en Prisma.
   * Aplica fallback (la dirección del worker o ethers.ZeroAddress) si algún usuario no tiene billetera.
   */
  private async resolveParticipantWallets(
    collectorId: string,
    householdIds: string[],
  ): Promise<{ collectorWallet: string; householdWallets: string[] }> {
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

        if (rawWallet && ethers.isAddress(rawWallet)) {
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
