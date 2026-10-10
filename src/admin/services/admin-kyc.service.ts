import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { BlockchainService } from '../../blockchain/services/blockchain.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { UploadsService } from '../../uploads/uploads.service';
import { CreateKycApplicationDto } from '../../kyc/dto/create-kyc-application.dto';
import { CreateB2bApplicationDto } from '../../b2b/dto/create-b2b-application.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { UpdateKycStatusDto } from '../dto/update-kyc-status.dto';
import { Role } from '@prisma/client';
import { CryptoUtil } from '../../common/utils/crypto.util';

@Injectable()
export class AdminKycService {
  private readonly logger = new Logger(AdminKycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly uploadsService?: UploadsService,
  ) {}

  async createKycApplication(userId: string, dto: CreateKycApplicationDto) {
    await this.prisma.user
      .update({
        where: { id: userId },
        data: {
          profilePhotoUrl: dto.selfieUrl ?? undefined,
          dniDocumentNumber: dto.documentNumber ?? undefined,
          dniPhotoUrl: dto.documentUrl ?? undefined,
          selfiePhotoUrl: dto.selfieUrl ?? undefined,
          kycStatus: 'PENDING',
        },
      })
      .catch(() => {});

    if (dto.taxIdRuc || dto.businessName || dto.documentUrl) {
      await this.prisma.storeProfile
        .updateMany({
          where: { userId },
          data: {
            ruc: dto.taxIdRuc ?? undefined,
            businessName: dto.businessName ?? undefined,
            bankAccount: dto.bankCci ?? undefined,
            logoUrl: dto.documentUrl ?? undefined,
          },
        })
        .catch(() => {});

      if (dto.businessName) {
        await this.prisma.user
          .update({
            where: { id: userId },
            data: { name: dto.businessName },
          })
          .catch(() => {});
      }
    }

    return this.prisma.kycApplication.create({
      data: {
        userId,
        documentUrl: dto.documentUrl,
        documentUrlBack: dto.documentUrlBack,
        selfieUrl: dto.selfieUrl,
        documentNumber: dto.documentNumber,
        transportType: dto.transportType,
        vehiclePlate: dto.vehiclePlate,
        associationName: dto.associationName,
        taxIdRuc: dto.taxIdRuc,
        businessName: dto.businessName,
        bankCci: dto.bankCci,
        status: 'PENDING',
      },
    });
  }

  async getMyKycApplication(userId: string) {
    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;
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

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const apps = await readPrisma.kycApplication.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            address: true,
            role: true,
            userStatus: true,
            kycStatus: true,
            profilePhotoUrl: true,
            isActive: true,
            createdAt: true,
            storeProfile: true,
          },
        },
      },
    });

    if (this.uploadsService) {
      return Promise.all(
        apps.map(async (app) => ({
          ...app,
          documentUrl: await this.uploadsService!.getFreshSignedUrl(app.documentUrl),
          documentUrlBack: await this.uploadsService!.getFreshSignedUrl(app.documentUrlBack),
          selfieUrl: await this.uploadsService!.getFreshSignedUrl(app.selfieUrl),
        })),
      );
    }

    return apps;
  }

  async updateUserKycStatus(userId: string, dto: UpdateKycStatusDto) {
    const kycApp = await this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const currentRetry = kycApp?.retryCount ?? 0;
    let newStatus = dto.status;
    let incrementRetry = currentRetry;

    if (dto.status === 'OBSERVED') {
      incrementRetry = currentRetry + 1;
      if (incrementRetry > 3) {
        newStatus = 'REJECTED';
      }
    }

    let updatedApp: any = null;
    if (kycApp) {
      updatedApp = await this.prisma.kycApplication.update({
        where: { id: kycApp.id },
        data: {
          status: newStatus,
          observationNotes: dto.observationNotes ?? kycApp.observationNotes,
          retryCount: incrementRetry,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              isActive: true,
            },
          },
        },
      });
    } else if (user.role === Role.TIENDA) {
      const storeProfile = await this.prisma.storeProfile.findUnique({
        where: { userId: user.id },
      });
      updatedApp = await this.prisma.kycApplication
        .create({
          data: {
            userId: user.id,
            status: newStatus,
            documentType: 'RUC',
            documentNumber: storeProfile?.ruc || null,
            taxIdRuc: storeProfile?.ruc || null,
            businessName:
              storeProfile?.businessName || user.name || 'Comercio Aliado',
            bankCci: storeProfile?.bankAccount || null,
            documentUrl: storeProfile?.logoUrl || null,
            observationNotes: dto.observationNotes || null,
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
                isActive: true,
              },
            },
          },
        })
        .catch(() => null);
    }

    if (newStatus === 'APPROVED') {
      const updateData: any = {
        isActive: true,
        kycStatus: 'APPROVED',
        kycVerifiedAt: new Date(),
      };
      if (user.role === 'RECOLECTOR' && kycApp?.selfieUrl) {
        updateData.profilePhotoUrl = kycApp.selfieUrl;
      }

      if (user.walletAddress && !user.isWalletSponsored && this.blockchainService) {
        try {
          let decryptedSecret: string | undefined;
          const vault = await this.prisma.walletVault.findUnique({
            where: { userId: user.id },
          });
          if (vault?.encryptedPrivateKey) {
            const encryptionKey =
              this.configService?.get<string>('WALLET_ENCRYPTION_KEY') ||
              this.configService?.get<string>('ENCRYPTION_KEY') ||
              process.env.WALLET_ENCRYPTION_KEY ||
              process.env.ENCRYPTION_KEY;
            if (encryptionKey) {
              decryptedSecret = CryptoUtil.decrypt(
                vault.encryptedPrivateKey,
                encryptionKey,
              );
            }
          }
          this.logger.log(
            `Patrocinando cuenta Stellar para usuario ${user.id} (${user.walletAddress})...`,
          );
          await this.blockchainService.sponsorAccountCreation(
            user.walletAddress,
            decryptedSecret,
          );
          updateData.isWalletSponsored = true;
        } catch (sponsorErr: any) {
          this.logger.error(
            `Error al patrocinar cuenta Stellar para usuario ${userId}: ${sponsorErr.message}`,
          );
        }
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      if (this.notificationsService) {
        const title =
          user.role === Role.TIENDA
            ? 'Comercio Verificado'
            : 'Verificación KYC Aprobada';
        const body =
          user.role === Role.TIENDA
            ? 'Tu comercio ha sido verificado con éxito. Ya puedes cobrar y recibir recompensas LIVO.'
            : 'Tu cuenta ha sido verificada con éxito. Ya estás habilitado para operar en Livora.';
        this.notificationsService
          .sendPushNotification(user.id, title, body, {
            type: 'KYC_APPROVED',
            role: user.role,
          })
          .catch(() => {});
      }
    } else if (newStatus === 'REJECTED') {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          isActive: user.role === 'RECOLECTOR' ? false : user.isActive,
          kycStatus: 'REJECTED',
          kycRejectionReason:
            dto.observationNotes || 'Rechazado en revisión administrativa',
        },
      });

      if (this.notificationsService) {
        this.notificationsService
          .sendPushNotification(
            user.id,
            'Expediente de Verificación Rechazado',
            `Tu solicitud de verificación no fue aprobada: ${dto.observationNotes || 'Verifica los requisitos reglamentarios'}`,
            { type: 'KYC_REJECTED', role: user.role },
          )
          .catch(() => {});
      }
    } else if (newStatus === 'OBSERVED') {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          kycStatus: 'OBSERVED',
          kycRejectionReason:
            dto.observationNotes || 'Observado en revisión administrativa',
        },
      });

      if (this.notificationsService) {
        this.notificationsService
          .sendPushNotification(
            user.id,
            'Expediente Observado',
            `Tu expediente requiere subsanación: ${dto.observationNotes || 'Revisa tus documentos en la aplicación'}`,
            { type: 'KYC_OBSERVED', role: user.role },
          )
          .catch(() => {});
      }
    }

    return updatedApp || { userId, status: newStatus };
  }
}
