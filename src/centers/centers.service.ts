import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class CentersService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * Genera un PIN aleatorio de 4 dígitos numéricos (1000 - 9999)
   */
  private generatePin(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  /**
   * GET /centers/me/reception-pin (Rol: CENTRO_ACOPIO)
   * Devuelve el PIN de recepción del centro de acopio autenticado. Si no posee uno, lo genera y guarda con TTL de 30 min en Redis.
   */
  async getReceptionPin(centerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: centerId },
    });

    if (!user) {
      throw new NotFoundException('Usuario Centro de Acopio no encontrado');
    }

    if (user.receptionPin) {
      if (this.redisService) {
        await this.redisService.set(
          `pin:center:${centerId}`,
          user.receptionPin,
          1800,
        );
      }
      return { receptionPin: user.receptionPin };
    }

    // Si no tiene PIN configurado, generar uno por defecto y guardarlo
    const newPin = this.generatePin();
    const updatedUser = await this.prisma.user.update({
      where: { id: centerId },
      data: { receptionPin: newPin },
    });

    if (this.redisService) {
      await this.redisService.set(`pin:center:${centerId}`, newPin, 1800);
    }

    return { receptionPin: updatedUser.receptionPin };
  }

  /**
   * POST /centers/me/reception-pin/refresh (Rol: CENTRO_ACOPIO)
   * Genera un nuevo PIN aleatorio de 4 dígitos numéricos, actualiza la BD y lo retorna con TTL de 30 min en Redis.
   */
  async refreshReceptionPin(centerId: string) {
    const newPin = this.generatePin();

    const updatedUser = await this.prisma.user.update({
      where: { id: centerId },
      data: { receptionPin: newPin },
    });

    if (this.redisService) {
      await this.redisService.set(`pin:center:${centerId}`, newPin, 1800);
    }

    return { receptionPin: updatedUser.receptionPin };
  }

  /**
   * Obtiene la lista de todos los Centros de Acopio registrados (Rol: CENTRO_ACOPIO)
   */
  async findAll() {
    return this.prisma.user.findMany({
      where: {
        role: { in: ['CENTRO_ACOPIO', 'ALMACEN'] },
        deletedAt: null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
        walletAddress: true,
        receptionPin: true,
      },
    });
  }

  /**
   * Búsqueda geoespacial optimizada con índice GiST de PostGIS para Centros de Acopio cercanos
   */
  async findNearby(lat: number, lng: number, radiusKm: number = 10) {
    const radiusMeters = radiusKm * 1000;
    return this.prisma.$queryRaw<any[]>`
      SELECT 
        id, 
        email, 
        name, 
        address, 
        latitude, 
        longitude, 
        "walletAddress",
        ST_Distance(
          ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        ) AS distance
      FROM users
      WHERE role IN ('CENTRO_ACOPIO', 'ALMACEN')
        AND "deletedAt" IS NULL
        AND "latitude" IS NOT NULL 
        AND "longitude" IS NOT NULL
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${radiusMeters}
        )
      ORDER BY distance ASC;
    `;
  }

  /**
   * Actualiza o crea el tarifario por material para un centro de acopio
   */
  async updatePriceList(
    centerId: string,
    prices: { materialType: string; pricePerKg: number }[],
  ) {
    const center = await this.prisma.user.findUnique({
      where: { id: centerId },
    });

    if (!center || (center.role !== 'CENTRO_ACOPIO' && center.role !== 'ALMACEN')) {
      throw new NotFoundException('Centro de acopio no encontrado');
    }

    const results: any[] = [];
    for (const item of prices) {
      const normMaterial = item.materialType.toUpperCase().trim();
      const upserted = await this.prisma.acopioPriceList.upsert({
        where: {
          centerId_materialType: {
            centerId,
            materialType: normMaterial,
          },
        },
        update: {
          pricePerKg: item.pricePerKg,
        },
        create: {
          centerId,
          materialType: normMaterial,
          pricePerKg: item.pricePerKg,
        },
      });
      results.push(upserted);
    }

    return results;
  }

  /**
   * Obtiene el tarifario de un centro de acopio específico
   */
  async getPriceList(centerId: string) {
    const center = await this.prisma.user.findUnique({
      where: { id: centerId },
      select: { id: true, name: true, email: true, address: true },
    });

    if (!center) {
      throw new NotFoundException('Centro de acopio no encontrado');
    }

    const prices = await this.prisma.acopioPriceList.findMany({
      where: { centerId },
      orderBy: { materialType: 'asc' },
    });

    return {
      center,
      prices,
    };
  }

  /**
   * Obtiene todos los tarifarios vigentes de todos los centros de acopio
   */
  async getAllPriceLists() {
    return this.prisma.user.findMany({
      where: {
        role: { in: ['CENTRO_ACOPIO', 'ALMACEN'] },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        address: true,
        latitude: true,
        longitude: true,
        priceLists: true,
      },
    });
  }
}
