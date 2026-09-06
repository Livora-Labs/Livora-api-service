import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';
import { CreateKycApplicationDto } from '../kyc/dto/create-kyc-application.dto';
import { CreateB2bApplicationDto } from '../b2b/dto/create-b2b-application.dto';
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateComplaintStatusDto } from '../complaints/dto/update-complaint-status.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
  ) {}

  async createKycApplication(userId: string, dto: CreateKycApplicationDto) {
    return this.prisma.kycApplication.create({
      data: {
        userId,
        documentUrl: dto.documentUrl,
        status: 'PENDING',
      },
    });
  }

  /**
   * Estado KYC del propio recolector. Devuelve NOT_SUBMITTED si aún no envió nada,
   * o el estado de su última solicitud (PENDING | APPROVED | REJECTED).
   */
  async getMyKycApplication(userId: string) {
    const readPrisma = (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;
    const app = await readPrisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!app) {
      return { status: 'NOT_SUBMITTED' };
    }

    return {
      status: app.status,
      documentUrl: app.documentUrl,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
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

    const readPrisma = (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    return readPrisma.kycApplication.findMany({
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
      network: 'Stellar Testnet',
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

  async retryPaymentMint(paymentId: string) {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { id: paymentId },
      include: { user: true },
    });

    if (!payment) {
      throw new NotFoundException('Transacción de pago no encontrada');
    }

    if (payment.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Solo se puede reintentar el minteo de pagos confirmados fiduciariamente (COMPLETED)',
      );
    }

    if (payment.blockchainStatus === 'MINTED') {
      return {
        message: 'Los tokens ya fueron minteados exitosamente en la blockchain',
        txHash: payment.txHash,
      };
    }

    if (!payment.user.walletAddress) {
      throw new BadRequestException(
        'El usuario no posee una billetera Stellar configurada',
      );
    }

    if (this.blockchainQueue) {
      const job = await this.blockchainQueue.add(
        'niubiz-mint-tokens',
        {
          userId: payment.userId,
          walletAddress: payment.user.walletAddress,
          amount: Number(payment.tokenAmount),
          purchaseNumber: payment.purchaseNumber,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: { blockchainStatus: 'PENDING' },
      });

      return {
        status: 'QUEUED',
        jobId: job.id,
        purchaseNumber: payment.purchaseNumber,
        tokenAmount: payment.tokenAmount,
        walletAddress: payment.user.walletAddress,
        message: 'Trabajo de minteo re-encolado en Stellar Soroban exitosamente',
      };
    }

    return {
      status: 'ERROR',
      message: 'Cola de blockchain no disponible en el servidor',
    };
  }
}
