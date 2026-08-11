import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IpfsService } from '../blockchain/services/ipfs.service';
import { CreateB2bTransferDto } from './dto/create-b2b-transfer.dto';
import { B2bTransferStatus } from '@prisma/client';

@Injectable()
export class B2bTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ipfsService: IpfsService,
  ) {}

  async createTransfer(centerId: string, dto: CreateB2bTransferDto) {
    const buyer = await this.prisma.user.findUnique({
      where: { id: dto.buyerId },
    });

    if (!buyer || buyer.role !== 'EMPRESA_B2B') {
      throw new NotFoundException('La empresa compradora B2B no existe.');
    }

    const SHRINK_FACTOR = 0.05; // 5% de merma industrial

    // Validate each material line has sufficient stock and satisfies conservation of mass
    for (const line of dto.materials) {
      const normMaterial = line.material.toUpperCase().trim();

      // 1. Validar la restricción contable de conservación de masa:
      //    salidas_totales <= entradas_pesadas * (1 - SHRINK_FACTOR)
      const aggregateIn = await this.prisma.inventoryMovement.aggregate({
        where: {
          centerId,
          materialType: { equals: normMaterial, mode: 'insensitive' },
          type: 'IN',
        },
        _sum: {
          quantityKg: true,
        },
      });

      const aggregateOut = await this.prisma.inventoryMovement.aggregate({
        where: {
          centerId,
          materialType: { equals: normMaterial, mode: 'insensitive' },
          type: 'OUT',
        },
        _sum: {
          quantityKg: true,
        },
      });

      const totalIn = aggregateIn._sum.quantityKg || 0;
      const totalOut = aggregateOut._sum.quantityKg || 0;

      const allowedLimit = totalIn * (1 - SHRINK_FACTOR);
      if (totalOut + line.weightKg > allowedLimit) {
        throw new BadRequestException(
          `La transferencia excede el límite contable de conservación de masa con merma del 5% para ${normMaterial}. ` +
          `Total entradas: ${totalIn} kg (límite con merma: ${allowedLimit.toFixed(2)} kg), ` +
          `Salidas históricas: ${totalOut} kg, Solicitado: ${line.weightKg} kg.`
        );
      }

      // 2. Validar existencia de stock físico libre en InventoryItem
      const invItem = await this.prisma.inventoryItem.findFirst({
        where: {
          centerId,
          materialType: { equals: normMaterial, mode: 'insensitive' },
        },
      });

      if (!invItem || invItem.quantityKg < line.weightKg) {
        throw new BadRequestException(
          `Inventario insuficiente para ${normMaterial}. Disponible: ${invItem?.quantityKg || 0} kg, requerido: ${line.weightKg} kg.`
        );
      }
    }

    // Deduct inventory and record OUT movements for each material
    for (const line of dto.materials) {
      const normMaterial = line.material.toUpperCase().trim();
      const invItem = await this.prisma.inventoryItem.findFirst({
        where: { centerId, materialType: { equals: normMaterial, mode: 'insensitive' } },
      });

      await this.prisma.inventoryItem.update({
        where: { id: invItem!.id },
        data: { quantityKg: { decrement: line.weightKg } },
      });

      await this.prisma.inventoryMovement.create({
        data: {
          centerId,
          materialType: normMaterial,
          quantityKg: line.weightKg,
          type: 'OUT',
        },
      });
    }

    // Build the materials map: { PET: 100, CARTON: 50, ... }
    const materialsMap: Record<string, number> = {};
    for (const line of dto.materials) {
      materialsMap[line.material.toUpperCase().trim()] = line.weightKg;
    }

    // Create the transfer
    return this.prisma.b2bTransfer.create({
      data: {
        materials: materialsMap,
        buyerId: dto.buyerId,
        centerId,
        status: B2bTransferStatus.IN_TRANSIT,
      },
      include: {
        buyer: { select: { id: true, email: true } },
        center: { select: { id: true, email: true } },
      },
    });
  }

  async getIncomingTransfers(buyerId: string) {
    return this.prisma.b2bTransfer.findMany({
      where: { buyerId, status: B2bTransferStatus.IN_TRANSIT },
      include: {
        center: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async receiveTransfer(id: string, buyerId: string) {
    const transfer = await this.prisma.b2bTransfer.findUnique({
      where: { id },
    });

    if (!transfer) {
      throw new NotFoundException('Transferencia B2B no encontrada.');
    }

    if (transfer.buyerId !== buyerId) {
      throw new BadRequestException('No tienes autorización para recibir esta transferencia.');
    }

    if (transfer.status !== B2bTransferStatus.IN_TRANSIT) {
      throw new BadRequestException('La transferencia ya ha sido recibida o procesada.');
    }

    // Actualizar estado a RECEIVED
    const updatedTransfer = await this.prisma.b2bTransfer.update({
      where: { id },
      data: { status: B2bTransferStatus.RECEIVED },
      include: {
        buyer: { select: { id: true, email: true } },
        center: { select: { id: true, email: true } },
      },
    });

    // Calculate total kg across all materials
    const materialsMap = (transfer.materials as Record<string, number>) || {};
    const totalKg = Object.values(materialsMap).reduce((sum, w) => sum + w, 0);
    const materialsList = Object.keys(materialsMap).join(', ');

    const esgImpact = {
      recycledMaterial: materialsList,
      recycledKg: totalKg,
      co2SavedKg: Number((totalKg * 2.5).toFixed(1)),
      waterSavedLiters: Number((totalKg * 10).toFixed(1)),
      materialsBreakdown: materialsMap,
    };

    // Subir metadatos de impacto ESG reales a Pinata IPFS
    const ipfsHash = await this.ipfsService.uploadJson(
      esgImpact,
      `certificate-${transfer.buyerId}-${Date.now()}`,
    );

    await this.prisma.certificate.create({
      data: {
        buyerId: transfer.buyerId,
        ipfsHash,
        esgImpact,
        status: 'ACTIVE',
      },
    });

    return updatedTransfer;
  }

  async getB2bCompanies() {
    return this.prisma.user.findMany({
      where: { role: 'EMPRESA_B2B' },
      select: { id: true, email: true, walletAddress: true },
    });
  }
}
