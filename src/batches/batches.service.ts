import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BatchStatus, ConsolidatedStatus, RequestStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { ReceiveBatchDto } from './dto/receive-batch.dto';
import { FindBatchesQueryDto } from './dto/find-batches-query.dto';
import { CreateConsolidatedBatchDto } from './dto/create-consolidated-batch.dto';

@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
  ) {}

  /**
   * GET /batches (Rol: RECOLECTOR / CENTRO_ACOPIO)
   * Devuelve el historial de lotes paginado con forzado de seguridad por rol.
   */
  async findAll(
    userId: string,
    role: string,
    query: FindBatchesQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'updatedAt', 'status'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as 'asc' | 'desc';

    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (role === Role.RECOLECTOR) {
      // Forzar por seguridad que solo consulte sus propios lotes
      where.collectorId = userId;
    } else if (role === Role.CENTRO_ACOPIO || role === Role.ALMACEN) {
      // Forzar por seguridad que solo consulte los lotes destinados a su centro de acopio o almacén
      where.destinationCenterId = userId;
    } else {
      throw new ForbiddenException('Rol no autorizado para listar lotes');
    }

    return this.prisma.batch.findMany({
      where,
      skip,
      take: limit,
      orderBy: { [sanitizedSortBy]: sortOrder },
      include: {
        collector: {
          select: { id: true, email: true },
        },
        destinationCenter: {
          select: { id: true, email: true },
        },
        requests: {
          include: {
            household: {
              select: { id: true, email: true },
            },
          },
        },
      },
    });
  }

  /**
   * GET /batches/open (Rol: RECOLECTOR)
   * Busca o crea un lote en estado OPEN asociado al recolector autenticado.
   * Devuelve el lote actual junto con las solicitudes de recolección asociadas.
   */
  async getOpenBatch(collectorId: string) {
    let batch = await this.prisma.batch.findFirst({
      where: {
        collectorId,
        status: BatchStatus.OPEN,
      },
      include: {
        requests: true,
      },
    });

    if (!batch) {
      batch = await this.prisma.batch.create({
        data: {
          collectorId,
          status: BatchStatus.OPEN,
        },
        include: {
          requests: true,
        },
      });
    }

    // Asociar al lote cualquier solicitud del recolector en estado ACCEPTED que no tenga batchId
    await this.prisma.collectionRequest.updateMany({
      where: {
        collectorId,
        status: RequestStatus.ACCEPTED,
        batchId: null,
      },
      data: {
        batchId: batch.id,
      },
    });

    // Retornar el lote actualizado con todas sus solicitudes asociadas
    return this.prisma.batch.findUnique({
      where: { id: batch.id },
      include: {
        requests: {
          include: {
            household: {
              select: { id: true, email: true },
            },
          },
        },
      },
    });
  }

  /**
   * PATCH /batches/:id (Rol: RECOLECTOR)
   * Asigna un centro de acopio destino y cambia el estado a IN_TRANSIT.
   */
  async updateBatch(id: string, collectorId: string, dto: UpdateBatchDto) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.collectorId !== collectorId) {
      throw new ForbiddenException('No tienes permisos para modificar este lote');
    }

    if (batch.status !== BatchStatus.OPEN) {
      throw new BadRequestException('Solo se pueden actualizar lotes en estado OPEN');
    }

    const destinationCenter = await this.prisma.user.findUnique({
      where: { id: dto.destinationCenterId },
    });

    if (!destinationCenter || (destinationCenter.role !== Role.CENTRO_ACOPIO && destinationCenter.role !== Role.ALMACEN)) {
      throw new BadRequestException(
        'El centro de acopio o almacén especificado no existe o no posee un rol autorizado',
      );
    }

    return this.prisma.batch.update({
      where: { id },
      data: {
        destinationCenterId: dto.destinationCenterId,
        status: BatchStatus.IN_TRANSIT,
      },
      include: {
        requests: true,
        destinationCenter: {
          select: { id: true, email: true },
        },
      },
    });
  }

  /**
   * POST /batches/:id/receive (Rol: CENTRO_ACOPIO)
   * Endpoint crítico de pesaje industrial y patrón HTTP 202.
   */
  async receiveBatch(id: string, centerId: string, dto: ReceiveBatchDto) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: {
        requests: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    // c) Validación de Idempotencia: Si el lote ya está en estado PROCESSING, RECEIVED o CONSOLIDATED, rechaza con HTTP 409 Conflict
    if (
      batch.status === BatchStatus.PROCESSING ||
      batch.status === BatchStatus.RECEIVED ||
      batch.status === BatchStatus.CONSOLIDATED
    ) {
      throw new ConflictException(
        'El lote ya se encuentra en procesamiento o fue recibido previamente',
      );
    }

    // a) Verifica que el lote esté en estado IN_TRANSIT
    if (batch.status !== BatchStatus.IN_TRANSIT) {
      throw new BadRequestException(
        'El lote debe estar en estado IN_TRANSIT para ser recibido',
      );
    }

    // b) Valida que el centro de acopio autenticado coincida con el destinationCenterId del lote
    if (batch.destinationCenterId !== centerId) {
      throw new ForbiddenException(
        'El centro de acopio autenticado no coincide con el centro de destino asignado al lote',
      );
    }

    // Transacción Asíncrona:
    // a) Actualiza el estado del lote a PROCESSING y guarda los pesos industriales en materialsActual
    const updatedBatch = await this.prisma.batch.update({
      where: { id },
      data: {
        status: BatchStatus.PROCESSING,
        materialsActual: dto.materialsActual,
      },
    });

    // Extraer IDs de hogares participantes desde las solicitudes asociadas
    const householdIds = Array.from(
      new Set(batch.requests.map((req) => req.householdId)),
    );

    // b) Encola un trabajo (Job) en la cola 'blockchain-queue' con el payload completo (Opción 3A)
    const jobPayload = {
      batchId: updatedBatch.id,
      collectorId: updatedBatch.collectorId,
      centerId,
      materialsActual: dto.materialsActual,
      householdIds,
    };

    const job = await this.blockchainQueue.add('process-batch-blockchain', jobPayload);

    // c) Responde de inmediato al cliente con HTTP 202 Accepted
    return {
      status: BatchStatus.PROCESSING,
      batchId: updatedBatch.id,
      transactionJobId: job.id ? String(job.id) : null,
    };
  }

  /**
   * POST /consolidated-batches (Rol: CENTRO_ACOPIO)
   * Consolida múltiples lotes en estado RECEIVED en un único ConsolidatedBatch usando Prisma $transaction.
   */
  async createConsolidatedBatch(centerId: string, dto: CreateConsolidatedBatchDto) {
    // 1. Obtener todos los lotes especificados
    const batches = await this.prisma.batch.findMany({
      where: {
        id: { in: dto.batchIds },
      },
    });

    if (batches.length !== dto.batchIds.length) {
      throw new NotFoundException('Uno o más lotes especificados no fueron encontrados');
    }

    // 2. Verificar que todos los lotes pertenezcan a este Centro de Acopio y estén en estado RECEIVED
    let totalWeight = 0;

    for (const batch of batches) {
      if (batch.destinationCenterId !== centerId) {
        throw new ForbiddenException(
          `El lote ${batch.id} no está destinado a este Centro de Acopio`,
        );
      }

      if (batch.status !== BatchStatus.RECEIVED) {
        throw new BadRequestException(
          `El lote ${batch.id} debe estar en estado RECEIVED para ser consolidado (estado actual: ${batch.status})`,
        );
      }

      // Sumar pesos desde materialsActual
      if (batch.materialsActual && typeof batch.materialsActual === 'object') {
        const materialsObj = batch.materialsActual as Record<string, number>;
        for (const key of Object.keys(materialsObj)) {
          const val = Number(materialsObj[key]);
          if (!isNaN(val) && val > 0) {
            totalWeight += val;
          }
        }
      }
    }

    // 3. Ejecutar transacción atómica en la base de datos
    return this.prisma.$transaction(async (tx) => {
      // a) Crear el registro ConsolidatedBatch
      const consolidatedBatch = await tx.consolidatedBatch.create({
        data: {
          centerId,
          totalWeight,
          status: ConsolidatedStatus.PENDING_SALE,
        },
      });

      // b) Actualizar todos los lotes individuales pasándolos a CONSOLIDATED y vinculándolos
      await tx.batch.updateMany({
        where: {
          id: { in: dto.batchIds },
        },
        data: {
          status: BatchStatus.CONSOLIDATED,
          consolidatedBatchId: consolidatedBatch.id,
        },
      });

      // c) Retornar el objeto ConsolidatedBatch creado junto con sus lotes asociados
      return tx.consolidatedBatch.findUnique({
        where: { id: consolidatedBatch.id },
        include: {
          batches: true,
          center: {
            select: { id: true, email: true },
          },
        },
      });
    });
  }
}
