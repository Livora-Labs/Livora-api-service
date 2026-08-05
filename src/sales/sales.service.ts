import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateCertificateDto } from '../certificates/dto/create-certificate.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /sales (Rol: CENTRO_ACOPIO)
   */
  async createSale(centerId: string, dto: CreateSaleDto) {
    const buyer = await this.prisma.user.findUnique({
      where: { id: dto.buyerId },
    });

    if (!buyer || buyer.role !== 'EMPRESA_B2B') {
      throw new NotFoundException('La empresa compradora B2B no existe o no posee el rol EMPRESA_B2B');
    }

    return this.prisma.sale.create({
      data: {
        centerId,
        buyerId: dto.buyerId,
        weightKg: dto.weightKg,
        totalAmount: dto.totalAmount,
      },
      include: {
        buyer: { select: { id: true, email: true } },
        center: { select: { id: true, email: true } },
      },
    });
  }

  /**
   * GET /certificates (Rol: EMPRESA_B2B)
   */
  async getCertificates(buyerId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    return this.prisma.certificate.findMany({
      where: { buyerId },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * GET /certificates/:id (Rol: EMPRESA_B2B)
   */
  async getCertificateById(id: string, buyerId: string) {
    const certificate = await this.prisma.certificate.findUnique({
      where: { id },
    });

    if (!certificate) {
      throw new NotFoundException('Certificado no encontrado');
    }

    if (certificate.buyerId !== buyerId) {
      throw new ForbiddenException('No tienes permisos para ver este certificado');
    }

    return certificate;
  }

  /**
   * POST /certificates (Rol: ADMIN)
   * Simula el minteo de certificado ESG y guarda en BD con un IPFS hash simulado.
   */
  async createCertificate(dto: CreateCertificateDto) {
    const buyer = await this.prisma.user.findUnique({
      where: { id: dto.buyerId },
    });

    if (!buyer || buyer.role !== 'EMPRESA_B2B') {
      throw new NotFoundException('La empresa compradora B2B especificada no existe');
    }

    const fakeIpfsHash = `ipfs://Qm${Date.now().toString(36)}${Math.random().toString(36).substring(2, 12)}CertESG`;

    return this.prisma.certificate.create({
      data: {
        buyerId: dto.buyerId,
        esgImpact: dto.esgImpact,
        ipfsHash: fakeIpfsHash,
        status: 'ACTIVE',
      },
    });
  }
}
