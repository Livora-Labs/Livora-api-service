import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateKycApplicationDto } from '../kyc/dto/create-kyc-application.dto';
import { CreateB2bApplicationDto } from '../b2b/dto/create-b2b-application.dto';
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async createKycApplication(userId: string, dto: CreateKycApplicationDto) {
    return this.prisma.kycApplication.create({
      data: {
        userId,
        documentUrl: dto.documentUrl,
        status: 'PENDING',
      },
    });
  }

  async createB2bApplication(dto: CreateB2bApplicationDto) {
    return {
      status: 'RECEIVED',
      message:
        'Solicitud B2B recibida exitosamente. Nuestro equipo se pondrá en contacto.',
      companyName: dto.companyName,
      email: dto.email,
      taxId: dto.taxId,
      createdAt: new Date().toISOString(),
    };
  }

  async getKycApplications(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    return this.prisma.kycApplication.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, email: true, role: true },
        },
      },
    });
  }

  async updateUserKycStatus(userId: string, dto: UpdateKycStatusDto) {
    const kycApp = await this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!kycApp) {
      throw new NotFoundException(
        'Solicitud KYC no encontrada para este usuario',
      );
    }

    return this.prisma.kycApplication.update({
      where: { id: kycApp.id },
      data: { status: dto.status },
    });
  }

  async updateUserStatus(userId: string, dto: UpdateUserStatusDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return {
      userId: user.id,
      email: user.email,
      isActive: dto.isActive,
      updatedAt: new Date().toISOString(),
    };
  }

  async getBlockchainHealth() {
    return {
      status: 'healthy',
      network: 'Arbitrum Sepolia',
      latency: '45ms',
      blockNumber: 1289450,
      timestamp: new Date().toISOString(),
    };
  }

  async updateComplaintStatus(
    complaintId: string,
    dto: UpdateComplaintStatusDto,
  ) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
    });

    if (!complaint) {
      throw new NotFoundException('Queja / reclamo no encontrado');
    }

    return this.prisma.complaint.update({
      where: { id: complaintId },
      data: { status: dto.status },
    });
  }
}
