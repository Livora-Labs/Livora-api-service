import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  BLOCKCHAIN_QUEUE,
  BLOCKCHAIN_DLQ,
} from '../blockchain/blockchain.constants';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { StellarRpcManagerService } from '../blockchain/services/stellar-rpc-manager.service';
import { AuditLogBufferService } from '../common/services/audit-log-buffer.service';
import { CreateKycApplicationDto } from '../kyc/dto/create-kyc-application.dto';
import { CreateB2bApplicationDto } from '../b2b/dto/create-b2b-application.dto';
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateComplaintStatusDto } from '../complaints/dto/update-complaint-status.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { FindUsersAdminQueryDto } from './dto/find-users-admin-query.dto';
import { LedgerAuditQueryDto, ServerLogsQueryDto } from './dto/audit-query.dto';
import { AdminResetPasswordDto } from './dto/admin-reset-password.dto';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.service';
import { AdminKycService } from './services/admin-kyc.service';
import { AdminAuditService } from './services/admin-audit.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly adminKycService: AdminKycService;
  private readonly adminAuditService: AdminAuditService;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
    @Optional()
    @InjectQueue(BLOCKCHAIN_DLQ)
    private readonly blockchainDlq?: Queue,
    @Optional()
    private readonly stellarRpcManager?: StellarRpcManagerService,
    @Optional()
    private readonly auditLogBuffer?: AuditLogBufferService,
    @Optional()
    private readonly blockchainService?: BlockchainService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly authService?: AuthService,
    @Optional()
    private readonly notificationsService?: NotificationsService,
    @Optional()
    private readonly uploadsService?: UploadsService,
    @Optional()
    adminKycService?: AdminKycService,
    @Optional()
    adminAuditService?: AdminAuditService,
  ) {
    this.adminKycService =
      adminKycService ||
      new AdminKycService(
        this.prisma,
        this.configService as any,
        this.blockchainService as any,
        this.notificationsService,
        this.uploadsService,
      );
    this.adminAuditService =
      adminAuditService ||
      new AdminAuditService(
        this.prisma,
        this.blockchainQueue,
        this.blockchainDlq,
        this.stellarRpcManager,
        this.auditLogBuffer,
      );
  }

  // --- KYC Delegations ---

  async createKycApplication(userId: string, dto: CreateKycApplicationDto) {
    return this.adminKycService.createKycApplication(userId, dto);
  }

  async getMyKycApplication(userId: string) {
    return this.adminKycService.getMyKycApplication(userId);
  }

  async createB2bApplication(dto: CreateB2bApplicationDto) {
    return this.adminKycService.createB2bApplication(dto);
  }

  async getKycApplications(query: PaginationQueryDto) {
    return this.adminKycService.getKycApplications(query);
  }

  async updateUserKycStatus(userId: string, dto: UpdateKycStatusDto) {
    return this.adminKycService.updateUserKycStatus(userId, dto);
  }

  // --- Audit & Operations Delegations ---

  async getBlockchainHealth() {
    return this.adminAuditService.getBlockchainHealth();
  }

  async getFinancialReconciliation() {
    return this.adminAuditService.getFinancialReconciliation();
  }

  async getLedgerAudit(query: LedgerAuditQueryDto) {
    return this.adminAuditService.getLedgerAudit(query);
  }

  async getQueueAudit() {
    return this.adminAuditService.getQueueAudit();
  }

  async retryQueueJob(jobId: string) {
    return this.adminAuditService.retryQueueJob(jobId);
  }

  async retryOutboxEvent(eventId: string) {
    return this.adminAuditService.retryOutboxEvent(eventId);
  }

  async getServerLogs(query: ServerLogsQueryDto) {
    return this.adminAuditService.getServerLogs(query);
  }

  async retryPaymentMint(paymentIdentifier: string) {
    return this.adminAuditService.retryPaymentMint(paymentIdentifier);
  }

  // --- User Management & Complaints ---

  async getUsers(query: FindUsersAdminQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.role) {
      where.role = query.role;
    }
    if (query.status) {
      where.userStatus = query.status;
    }
    if (query.search && query.search.trim().length > 0) {
      const q = query.search.trim();
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { walletAddress: { contains: q, mode: 'insensitive' } },
      ];
    }

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, users] = await Promise.all([
      readPrisma.user.count({ where }),
      readPrisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          address: true,
          role: true,
          userStatus: true,
          kycStatus: true,
          kycVerifiedAt: true,
          isActive: true,
          walletAddress: true,
          profilePhotoUrl: true,
          marketingAccepted: true,
          createdAt: true,
          updatedAt: true,
          storeProfile: {
            select: {
              id: true,
              businessName: true,
              ruc: true,
              address: true,
              bankAccount: true,
              logoUrl: true,
            },
          },
          kycApplications: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              documentType: true,
              documentNumber: true,
              documentUrl: true,
              documentUrlBack: true,
              selfieUrl: true,
              taxIdRuc: true,
              businessName: true,
              bankCci: true,
              transportType: true,
              vehiclePlate: true,
              associationName: true,
              observationNotes: true,
              retryCount: true,
              createdAt: true,
            },
          },
          _count: {
            select: {
              collectorBatches: true,
              householdRequests: true,
              collectorRequests: true,
              kycApplications: true,
            },
          },
        },
      }),
    ]);

    let finalUsers = users;
    if (this.uploadsService) {
      finalUsers = await Promise.all(
        users.map(async (u) => {
          let refreshedKyc = u.kycApplications;
          if (u.kycApplications && u.kycApplications.length > 0) {
            refreshedKyc = await Promise.all(
              u.kycApplications.map(async (app) => ({
                ...app,
                documentUrl: await this.uploadsService!.getFreshSignedUrl(app.documentUrl),
                documentUrlBack: await this.uploadsService!.getFreshSignedUrl(app.documentUrlBack),
                selfieUrl: await this.uploadsService!.getFreshSignedUrl(app.selfieUrl),
              }))
            );
          }
          let refreshedStore = u.storeProfile;
          if (u.storeProfile?.logoUrl) {
            refreshedStore = {
              ...u.storeProfile,
              logoUrl: await this.uploadsService!.getFreshSignedUrl(u.storeProfile.logoUrl),
            };
          }
          return {
            ...u,
            profilePhotoUrl: await this.uploadsService!.getFreshSignedUrl(u.profilePhotoUrl),
            storeProfile: refreshedStore,
            kycApplications: refreshedKyc,
          };
        })
      );
    }

    return {
      data: finalUsers,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }

  async updateUserStatus(userId: string, dto: UpdateUserStatusDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role === 'ADMIN' && dto.isActive === false) {
      throw new BadRequestException('No es posible suspender una cuenta con rol de Administrador.');
    }

    const dataToUpdate: any = {};
    if (dto.isActive !== undefined) {
      dataToUpdate.isActive = dto.isActive;
    }
    if (dto.userStatus !== undefined) {
      dataToUpdate.userStatus = dto.userStatus;
    } else if (dto.isActive === false && user.userStatus === 'ACTIVE') {
      dataToUpdate.userStatus = 'SUSPENDED_FRAUD';
    } else if (dto.isActive === true && user.userStatus !== 'ACTIVE') {
      dataToUpdate.userStatus = 'ACTIVE';
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
    });

    return {
      userId: updatedUser.id,
      email: updatedUser.email,
      isActive: updatedUser.isActive,
      userStatus: updatedUser.userStatus,
      updatedAt: updatedUser.updatedAt.toISOString(),
    };
  }

  async regularizeUserPassword(userId: string, dto: AdminResetPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (!dto.newPassword && !dto.sendResetEmail) {
      throw new BadRequestException(
        'Debes proporcionar una nueva contraseña o solicitar el envío de correo de recuperación.',
      );
    }

    const results: { passwordUpdated?: boolean; emailSent?: boolean; message: string } = {
      message: '',
    };

    if (dto.newPassword) {
      const passwordHash = await bcrypt.hash(dto.newPassword, 12);
      await this.prisma.userCredential.upsert({
        where: { userId },
        update: {
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
          lastPasswordChange: new Date(),
        },
        create: {
          userId,
          passwordHash,
          lastPasswordChange: new Date(),
        },
      });
      results.passwordUpdated = true;
    }

    if (dto.sendResetEmail) {
      if (!this.authService) {
        throw new BadRequestException('Servicio de correo de recuperación no disponible');
      }
      await this.authService.forgotPassword({ email: user.email });
      results.emailSent = true;
    }

    if (results.passwordUpdated && results.emailSent) {
      results.message = `Contraseña actualizada manualmente y correo de recuperación enviado a ${user.email}`;
    } else if (results.passwordUpdated) {
      results.message = `Contraseña actualizada exitosamente para ${user.email}`;
    } else {
      results.message = `Correo de recuperación de contraseña enviado exitosamente a ${user.email}`;
    }

    return results;
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
