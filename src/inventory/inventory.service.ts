import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { MovementType } from '@prisma/client';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';

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
      if (!existingItem || Number(existingItem.quantityKg) < dto.quantityKg) {
        throw new BadRequestException(
          `Stock insuficiente de ${dto.materialType} para realizar la salida (disponible: ${Number(existingItem?.quantityKg ?? 0)} kg)`,
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
        const currentQty = Number(existingItem.quantityKg);
        const newQuantity =
          dto.type === MovementType.IN
            ? currentQty + dto.quantityKg
            : currentQty - dto.quantityKg;

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

  /**
   * GET /inventory/movements
   * Retorna el historial cronológico de movimientos (Kárdex) de un centro de acopio.
   */
  async getMovements(
    centerId?: string,
    materialType?: string,
    page = 1,
    limit = 15,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {
      ...(centerId ? { centerId } : {}),
      ...(materialType
        ? {
            materialType: {
              equals: materialType.toUpperCase().trim(),
              mode: 'insensitive',
            },
          }
        : {}),
    };

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, movements] = await Promise.all([
      readPrisma.inventoryMovement.count({ where }),
      readPrisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return new PaginatedResultDto(movements, total, page, limit);
  }
}
