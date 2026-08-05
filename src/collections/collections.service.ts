import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { RequestStatus, Role } from '@prisma/client';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
  ) {}

  /**
   * Crea una nueva solicitud de recolección (Rol HOGAR)
   */
  async create(
    userId: string,
    dto: CreateCollectionDto,
    file?: Express.Multer.File,
  ) {
    // Generar PIN aleatorio de 4 dígitos (1000 - 9999)
    const verificationPin = Math.floor(1000 + Math.random() * 9000).toString();

    // Procesar la foto de forma opcional
    let photoUrl: string | undefined = undefined;
    if (file) {
      photoUrl = await this.uploadPhoto(file, userId);
    }

    return this.prisma.collectionRequest.create({
      data: {
        status: RequestStatus.PENDING,
        itemsEstimated: dto.itemsEstimated,
        description: dto.description,
        verificationPin,
        latitude: dto.latitude,
        longitude: dto.longitude,
        photoUrl,
        householdId: userId,
      },
    });
  }

  /**
   * Obtener solicitudes según el rol del usuario autenticado
   * - HOGAR: Historial de sus propias solicitudes
   * - RECOLECTOR: Solicitudes PENDING cercanas usando PostGIS ST_DistanceSphere (o todas las PENDING)
   */
  async findAll(
    user: { id: string; role: string },
    query: FindCollectionsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'updatedAt', 'status'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as 'asc' | 'desc';

    if (user.role === Role.HOGAR) {
      return this.prisma.collectionRequest.findMany({
        where: { householdId: user.id },
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include: {
          collector: {
            select: { id: true, email: true },
          },
        },
      });
    }

    if (user.role === Role.RECOLECTOR) {
      const { lat, lng, radius = 5 } = query;

      if (lat !== undefined && lng !== undefined) {
        const radiusInMeters = radius * 1000;
        
        // Búsqueda espacial con PostGIS ST_DistanceSphere (LIMIT y OFFSET de forma segura)
        const results = await this.prisma.$queryRaw<any[]>`
          SELECT 
            id, 
            status, 
            "itemsEstimated", 
            "photoUrl", 
            description, 
            "verificationPin", 
            latitude, 
            longitude, 
            "householdId", 
            "collectorId", 
            "createdAt", 
            "updatedAt",
            ST_DistanceSphere(
              ST_MakePoint(longitude, latitude),
              ST_MakePoint(${lng}, ${lat})
            ) AS distance
          FROM collection_requests
          WHERE status = 'PENDING'::"RequestStatus"
            AND ST_DistanceSphere(
              ST_MakePoint(longitude, latitude),
              ST_MakePoint(${lng}, ${lat})
            ) <= ${radiusInMeters}
          ORDER BY distance ASC
          LIMIT ${limit} OFFSET ${skip};
        `;

        return results;
      }

      // Si el recolector no provee lat/lng, retornar todas las solicitudes PENDING con paginación
      return this.prisma.collectionRequest.findMany({
        where: { status: RequestStatus.PENDING },
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include: {
          household: {
            select: { id: true, email: true },
          },
        },
      });
    }

    throw new ForbiddenException('Rol no autorizado para listar solicitudes de recolección');
  }

  /**
   * Obtener detalle de una solicitud por ID
   * - HOGAR: Solo puede ver sus propias solicitudes (householdId === userId)
   * - RECOLECTOR: Puede ver cualquier solicitud
   */
  async findOne(id: string, userId: string, role: string) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: {
          select: { id: true, email: true },
        },
        collector: {
          select: { id: true, email: true },
        },
        batch: true,
      },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (role === Role.HOGAR && collectionRequest.householdId !== userId) {
      throw new ForbiddenException('No tienes permisos para ver esta solicitud');
    }

    return collectionRequest;
  }

  /**
   * Actualizar el estado de una solicitud
   * - RECOLECTOR: Acepta la solicitud (PENDING -> ACCEPTED, asigna collectorId)
   * - HOGAR: Cancela su propia solicitud (PENDING/ACCEPTED -> CANCELLED)
   */
  async updateStatus(
    id: string,
    userId: string,
    role: string,
    dto: UpdateCollectionStatusDto,
  ) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (role === Role.RECOLECTOR) {
      if (dto.status === RequestStatus.ACCEPTED) {
        if (collectionRequest.status !== RequestStatus.PENDING) {
          throw new BadRequestException(
            'La solicitud no está en estado PENDING y no puede ser aceptada',
          );
        }

        return this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.ACCEPTED,
            collectorId: userId,
          },
        });
      }

      throw new BadRequestException(
        'Un recolector únicamente puede cambiar el estado a ACCEPTED',
      );
    }

    if (role === Role.HOGAR) {
      if (collectionRequest.householdId !== userId) {
        throw new ForbiddenException(
          'No tienes permisos para actualizar una solicitud de otro hogar',
        );
      }

      if (dto.status === RequestStatus.CANCELLED) {
        if (
          collectionRequest.status === RequestStatus.COMPLETED ||
          collectionRequest.status === RequestStatus.CANCELLED
        ) {
          throw new BadRequestException(
            'No se puede cancelar una solicitud finalizada o previamente cancelada',
          );
        }

        return this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.CANCELLED,
          },
        });
      }

      throw new BadRequestException(
        'Un hogar únicamente puede cambiar el estado a CANCELLED',
      );
    }

    throw new ForbiddenException('Rol no autorizado para actualizar el estado');
  }

  /**
   * Helper para subida de imágenes a Supabase Storage o retorno de URL
   */
  private async uploadPhoto(
    file: Express.Multer.File,
    userId: string,
  ): Promise<string> {
    try {
      const supabase = this.supabaseService.getClient();
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${userId}_${Date.now()}.${fileExt}`;
      const filePath = `collections/${fileName}`;

      const { data, error } = await supabase.storage
        .from('collections')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (error) {
        // Fallback en caso de que el bucket de Supabase no exista en el entorno local
        return `https://supabase.local/storage/v1/object/public/collections/${filePath}`;
      }

      const { data: publicUrlData } = supabase.storage
        .from('collections')
        .getPublicUrl(filePath);

      return publicUrlData.publicUrl;
    } catch {
      return `https://supabase.local/storage/v1/object/public/collections/${userId}_${Date.now()}`;
    }
  }
}
