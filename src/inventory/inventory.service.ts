import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { MovementType } from '@prisma/client';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /inventory
   */
  async getInventory(centerId?: string) {
    return this.prisma.inventoryItem.findMany({
      where: centerId ? { centerId } : undefined,
      include: {
        center: { select: { id: true, email: true } },
      },
    });
  }

  /**
   * POST /inventory/movements
   * Registra un movimiento de entrada/salida y actualiza el stock actual de la planta/almacén.
   */
  async createMovement(centerId: string, dto: CreateMovementDto) {
    const existingItem = await this.prisma.inventoryItem.findFirst({
      where: {
        centerId,
        materialType: dto.materialType,
      },
    });

    if (dto.type === MovementType.OUT) {
      if (!existingItem || existingItem.quantityKg < dto.quantityKg) {
        throw new BadRequestException(
          `Stock insuficiente de ${dto.materialType} para realizar la salida (disponible: ${existingItem?.quantityKg ?? 0} kg)`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Crear el movimiento de inventario
      const movement = await tx.inventoryMovement.create({
        data: {
          centerId,
          type: dto.type,
          quantityKg: dto.quantityKg,
          materialType: dto.materialType,
        },
      });

      // 2. Actualizar o crear el item de inventario en stock
      if (existingItem) {
        const newQuantity =
          dto.type === MovementType.IN
            ? existingItem.quantityKg + dto.quantityKg
            : existingItem.quantityKg - dto.quantityKg;

        await tx.inventoryItem.update({
          where: { id: existingItem.id },
          data: { quantityKg: newQuantity },
        });
      } else {
        await tx.inventoryItem.create({
          data: {
            centerId,
            materialType: dto.materialType,
            quantityKg: dto.quantityKg,
          },
        });
      }

      return movement;
    });
  }
}
