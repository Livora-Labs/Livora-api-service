import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CryptoUtil } from '../common/utils/crypto.util';
import { Keypair } from '@stellar/stellar-sdk';
import { User, ConsentAudit, RequestStatus, Role, PlatformType } from '@prisma/client';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { WalletsService } from '../wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly walletsService?: WalletsService,
  ) {}

  onModuleInit() {
    this.getMasterEncryptionKey();
  }

  getMasterEncryptionKey(): string {
    const key =
      this.configService.get<string>('ENCRYPTION_MASTER_KEY') ||
      this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
      this.configService.get<string>('ENCRYPTION_KEY');

    const invalidFallbacks = new Set([
      'default-secret-key-32-chars-long!!',
      'test_isolated_wallet_encryption_key_32c',
      'livora_wallet_aes256_secret!',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'd7a5e8f1c3b2a49018e7d6c5b4a39281f0e1d2c3b4a596877869504132231405',
      'your_32_byte_wallet_encryption_key',
      'your_64_character_hex_encryption_master_key_here',
      'default_fallback',
    ]);

    if (
      !key ||
      key.trim() === '' ||
      invalidFallbacks.has(key.trim()) ||
      key.trim().toLowerCase().includes('fallback') ||
      key.trim().toLowerCase().includes('default-secret')
    ) {
      throw new Error('FATAL: ENCRYPTION_MASTER_KEY must be configured');
    }

    return key.trim();
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  private userCache = new Map<string, { user: User; expires: number }>();

  async findById(id: string): Promise<User | null> {
    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();
      const cached = this.userCache.get(id);
      if (cached && cached.expires > now) {
        return cached.user;
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (user && process.env.NODE_ENV !== 'test') {
      const now = Date.now();
      this.userCache.set(id, { user, expires: now + 10000 });
      if (this.userCache.size > 2000) {
        for (const [k, v] of this.userCache.entries()) {
          if (v.expires <= now) this.userCache.delete(k);
        }
      }
    }

    return user;
  }

  async autoProvisionFromAuth(userOrId: string | any): Promise<User | null> {
    const id = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    if (!id) return null;
    return this.findById(id);
  }

  async create(
    userId: string,
    registerDto: RegisterDto,
    passwordHash?: string,
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

    // Obtener la clave secreta de encriptación y validar
    const encryptionKey = this.getMasterEncryptionKey();

    // Encriptar clave privada con AES-256-GCM
    const encryptedPrivateKey = CryptoUtil.encrypt(privateKey, encryptionKey);

    // Guardar usuario en PostgreSQL utilizando transacción atómica
    const createdUser = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          email: registerDto.email,
          role: registerDto.role,
          walletAddress,
          encryptedPrivateKey,
          marketingAccepted: registerDto.marketingAccepted ?? false,
        },
      });

      if (passwordHash) {
        await tx.userCredential.create({
          data: {
            userId: user.id,
            passwordHash,
          },
        });
      }

      // Auto-aprovisionar perfil de tienda inicial si el rol es TIENDA
      if (registerDto.role === Role.TIENDA) {
        await tx.storeProfile.create({
          data: {
            userId: user.id,
            businessName: registerDto.email.split('@')[0],
            ruc: '',
            address: '',
            bankAccount: '',
          },
        });
      }

      return user;
    });

    if (process.env.NODE_ENV !== 'test') {
      this.userCache.set(createdUser.id, { user: createdUser, expires: Date.now() + 10000 });
    }

    // Retornar usuario despojando campos sensibles
    const { encryptedPrivateKey: _, ...userWithoutSecrets } = createdUser;
    return userWithoutSecrets;
  }

  async updateFcmToken(id: string, fcmToken: string): Promise<User> {
    await this.registerDeviceToken(id, { token: fcmToken }).catch(() => {});
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
    const anonymousEmail = `deleted_${id}_${Date.now()}@anon.livora.pe`;

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
          name: 'ANONIMO',
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

      // 4. Disociar reclamos / quejas del usuario sin destruir el expediente legal
      // (Cumplimiento de obligación legal de custodia por 2 años ante Indecopi D.S. 011-2011-PCM y Art. 13.1 Ley 29733 de bloqueo de datos)
      await tx.complaint.updateMany({
        where: { userId: id },
        data: {
          userId: null,
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

      // 7. Eliminar credenciales de acceso asociadas
      await tx.userCredential.deleteMany({
        where: { userId: id },
      });
    });

    return {
      success: true,
      message:
        'Cuenta cancelada y datos personales anonimizados irreversiblemente conforme a la Ley 29733',
    };
  }

  async anonymizeUser(
    id: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.cancelAccountARCO(id);
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

    if (dto.marketingAccepted !== undefined && dto.marketingAccepted !== user.marketingAccepted) {
      await this.prisma.consentAudit.create({
        data: {
          userId: id,
          termsVersion: '2.0.0',
          privacyVersion: '2.0.0',
          marketingAccepted: dto.marketingAccepted,
          documentHash: 'update-consent-profile',
          ipAddress: 'profile-update',
          userAgent: 'LivoraApp/Client',
          consentedAt: new Date(),
        },
      });
    }

    // Sincronización bidireccional defensiva: si el usuario es TIENDA y actualiza su nombre/dirección,
    // reflejar de inmediato en su storeProfile para evitar desincronizaciones en mapa y catálogos.
    if (user.role === Role.TIENDA) {
      await this.prisma.storeProfile
        .updateMany({
          where: { userId: id },
          data: {
            businessName: dto.name !== undefined ? dto.name : undefined,
            address: dto.address !== undefined ? dto.address : undefined,
          },
        })
        .catch(() => {});
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

  async changePassword(id: string, newPassword: string, currentPassword?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { credentials: true },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentPassword && currentPassword === newPassword) {
      throw new BadRequestException(
        'La nueva contraseña debe ser diferente a la contraseña actual',
      );
    }

    if (currentPassword) {
      if (!user.credentials) {
        throw new BadRequestException('El usuario no posee credenciales registradas');
      }
      const isMatch = await bcrypt.compare(currentPassword, user.credentials.passwordHash);
      if (!isMatch) {
        throw new BadRequestException('La contraseña actual es incorrecta.');
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.userCredential.upsert({
      where: { userId: id },
      update: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastPasswordChange: new Date(),
      },
      create: {
        userId: id,
        passwordHash,
        lastPasswordChange: new Date(),
      },
    });

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
        status: {
          in: [
            RequestStatus.PENDING,
            RequestStatus.AUCTION_ACTIVE,
            RequestStatus.AUCTION_ASSIGNED,
            RequestStatus.ACCEPTED,
            RequestStatus.EN_ROUTE,
            RequestStatus.ARRIVED,
          ],
        },
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
      } else {
        const mats =
          (r.actualWeights as Record<string, number>) ||
          (r.itemsEstimated as Record<string, number>) ||
          {};
        for (const [mat, rawWt] of Object.entries(mats)) {
          const userWt =
            typeof rawWt === 'number' ? rawWt : parseFloat(String(rawWt)) || 0;
          totalKgRecycled += userWt;
          const factor = EMISSION_FACTORS[mat.toUpperCase()] || 2.0;
          co2SavedKg += userWt * factor;
        }
      }
    }

    // 3. Balance de la Wallet
    const balanceRes = this.walletsService
      ? await this.walletsService.getBalance(userId)
      : { balance: '0.0' };

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

  /**
   * Registra o reasigna un token FCM en el modelo DeviceToken.
   * Si el token ya existía en la base de datos para otro usuario, se reasigna limpiamente al usuario actual.
   */
  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    const platform = dto.platform || PlatformType.ANDROID;

    const deviceToken = await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      update: {
        userId,
        platform,
        updatedAt: new Date(),
      },
      create: {
        userId,
        token: dto.token,
        platform,
      },
    });

    // Sincronizar en User.fcmToken para compatibilidad
    await this.prisma.user
      .update({
        where: { id: userId },
        data: { fcmToken: dto.token },
      })
      .catch(() => {});

    return deviceToken;
  }

  /**
   * Elimina el DeviceToken de FCM del usuario al cerrar sesión (logout).
   */
  async unregisterDeviceToken(userId: string, token?: string) {
    if (token) {
      await this.prisma.deviceToken
        .deleteMany({
          where: { token, userId },
        })
        .catch(() => {});
    } else {
      await this.prisma.deviceToken
        .deleteMany({
          where: { userId },
        })
        .catch(() => {});
    }
    await this.prisma.user
      .update({
        where: { id: userId },
        data: { fcmToken: null },
      })
      .catch(() => {});
  }
}
