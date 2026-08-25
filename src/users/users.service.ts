import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CryptoUtil } from '../common/utils/crypto.util';
import { Keypair } from '@stellar/stellar-sdk';
import { User, ConsentAudit, RequestStatus, Role } from '@prisma/client';
import * as crypto from 'crypto';
import { WalletsService } from '../wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly walletsService: WalletsService,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async create(
    supabaseUserId: string,
    registerDto: RegisterDto,
  ): Promise<Omit<User, 'encryptedPrivateKey'>> {
    const existingUser = await this.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado',
      );
    }

    // Generar billetera Web3 aleatoria con Stellar
    const pair = Keypair.random();
    const walletAddress = pair.publicKey();
    const privateKey = pair.secret();

    // Obtener la clave secreta de encriptación
    const encryptionKey =
      this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
      this.configService.get<string>('WALLET_SECRET_KEY') ||
      'livora_wallet_aes256_secret!';

    // Encriptar clave privada con AES-256-GCM
    const encryptedPrivateKey = CryptoUtil.encrypt(privateKey, encryptionKey);

    // Guardar usuario en PostgreSQL utilizando el id retornado por Supabase
    const createdUser = await this.prisma.user.create({
      data: {
        id: supabaseUserId,
        email: registerDto.email,
        role: registerDto.role,
        walletAddress,
        encryptedPrivateKey,
        marketingAccepted: registerDto.marketingAccepted ?? false,
      },
    });

    // Retornar usuario despojando campos sensibles
    const { encryptedPrivateKey: _, ...userWithoutSecrets } = createdUser;
    return userWithoutSecrets;
  }

  async updateFcmToken(id: string, fcmToken: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { fcmToken },
    });
  }

  async cancelAccountARCO(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt !== null || !user.isActive) {
      throw new NotFoundException('Usuario no encontrado o ya cancelado');
    }

    const originalEmail = user.email;
    const anonymousEmail = `deleted_${id.substring(0, 8)}_${Date.now()}@deleted.livora.org`;

    // Transacción atómica multitable en PostgreSQL para anonimización irreversible
    await this.prisma.$transaction(async (tx) => {
      // 1. Anonimizar usuario, destruir custodia de clave privada Web3 y marcar soft-delete
      await tx.user.update({
        where: { id },
        data: {
          email: anonymousEmail,
          encryptedPrivateKey: null, // Destrucción irreversible de la clave privada
          fcmToken: null,
          receptionPin: null,
          isActive: false,
          deletedAt: new Date(),
          name: null,
          phone: null,
          address: null,
          latitude: null,
          longitude: null,
          marketingAccepted: false,
        },
      });

      // 2. Anonimizar perfil de tienda si existe
      await tx.storeProfile.updateMany({
        where: { userId: id },
        data: {
          businessName: 'Tienda Anonimizada (ARCO)',
          ruc: '00000000000',
          address: 'Dirección Anonimizada',
          bankAccount: 'ANONIMIZADO',
          logoUrl: null,
        },
      });

      // 3. Purgar documentos KYC y marcar como rechazado
      await tx.kycApplication.updateMany({
        where: { userId: id },
        data: {
          documentUrl: null,
          status: 'REJECTED',
        },
      });

      // 4. Anonimizar reclamos / quejas
      await tx.complaint.updateMany({
        where: { userId: id },
        data: {
          subject: 'Queja Anonimizada',
          description:
            'Contenido suprimido por solicitud de cancelación ARCO (Ley 29733)',
        },
      });

      // 5. Eliminar notificaciones privadas del usuario
      await tx.notification.deleteMany({
        where: { userId: id },
      });

      // 6. Eliminar datos en lista de espera beta si existen
      await tx.betaSignup.deleteMany({
        where: { email: originalEmail },
      });
    });

    // 7. Eliminar identidad en Supabase Auth admin API (defensivo)
    try {
      const supabaseClient = this.supabaseService.getClient();
      await supabaseClient.auth.admin.deleteUser(id);
    } catch (error: any) {
      this.logger.warn(
        `Error al eliminar usuario en Supabase Auth durante ARCO: ${error?.message || error}`,
      );
    }

    return {
      success: true,
      message:
        'Cuenta cancelada y datos personales anonimizados irreversiblemente conforme a la Ley 29733',
    };
  }

  async deleteAccountGDPR(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.cancelAccountARCO(id);
  }

  async getConsentAudits(userId: string): Promise<ConsentAudit[]> {
    return this.prisma.consentAudit.findMany({
      where: { userId },
      orderBy: { consentedAt: 'desc' },
    });
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || !user.isActive || user.deletedAt) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name : undefined,
        phone: dto.phone !== undefined ? dto.phone : undefined,
        address: dto.address !== undefined ? dto.address : undefined,
        latitude: dto.latitude !== undefined ? dto.latitude : undefined,
        longitude: dto.longitude !== undefined ? dto.longitude : undefined,
        marketingAccepted: dto.marketingAccepted !== undefined ? dto.marketingAccepted : undefined,
      },
    });
  }

  async changePassword(id: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || !user.isActive || user.deletedAt) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const supabaseClient = this.supabaseService.getClient();
    const { error } = await supabaseClient.auth.admin.updateUserById(id, {
      password: newPassword,
    });
    if (error) {
      throw new BadRequestException(
        error.message || 'Error al actualizar la contraseña en Supabase',
      );
    }
    return { success: true, message: 'Contraseña actualizada con éxito' };
  }

  async getDashboard(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.deletedAt) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // 1. Solicitud activa
    const activeRequest = await this.prisma.collectionRequest.findFirst({
      where: {
        householdId: userId,
        status: { in: [RequestStatus.PENDING, RequestStatus.ACCEPTED] },
      },
      orderBy: { createdAt: 'desc' },
    });

    let mappedActiveRequest: any = null;
    if (activeRequest) {
      const items = (activeRequest.itemsEstimated as Record<string, number>) || {};
      const estimatedKg = Object.values(items).reduce((sum, val) => sum + val, 0);
      mappedActiveRequest = {
        id: activeRequest.id,
        pin: activeRequest.verificationPin,
        status: activeRequest.status,
        estimatedKg: Number(estimatedKg.toFixed(2)),
        createdAt: activeRequest.createdAt,
      };
    }

    // 2. Calcular las métricas ESG reales
    const completedRequests = await this.prisma.collectionRequest.findMany({
      where: {
        householdId: userId,
        status: RequestStatus.COMPLETED,
        batchId: { not: null },
      },
      include: {
        batch: true,
      },
    });

    let totalKgRecycled = 0;
    let co2SavedKg = 0;
    const totalCollections = completedRequests.length;

    const EMISSION_FACTORS: Record<string, number> = {
      PET: 3.0,
      CARTON: 1.5,
      CARTÓN: 1.5,
      VIDRIO: 0.8,
      PLASTICO: 2.5,
      PLÁSTICO: 2.5,
      ALUMINIO: 9.0,
      HDPE: 2.5,
    };

    for (const r of completedRequests) {
      if (r.batch?.status === 'RECEIVED') {
        const mats = (r.batch.materialsActual as Record<string, number>) || {};
        const siblings = await this.prisma.collectionRequest.count({
          where: { batchId: r.batchId },
        });
        const divisor = siblings || 1;

        for (const [mat, wt] of Object.entries(mats)) {
          const userWt = wt / divisor;
          totalKgRecycled += userWt;
          const factor = EMISSION_FACTORS[mat.toUpperCase()] || 2.0;
          co2SavedKg += userWt * factor;
        }
      }
    }

    // 3. Balance de la Wallet
    const balanceRes = await this.walletsService.getBalance(userId);

    return {
      activeRequest: mappedActiveRequest,
      esgMetrics: {
        totalKgRecycled: Number(totalKgRecycled.toFixed(2)),
        co2SavedKg: Number(co2SavedKg.toFixed(2)),
        totalCollections,
      },
      wallet: {
        publicKey: user.walletAddress || '',
        network: this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') || 'Testnet',
        balance: balanceRes.balance,
      },
    };
  }
}
