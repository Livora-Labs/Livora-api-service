import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CryptoUtil } from '../common/utils/crypto.util';
import { Keypair } from '@stellar/stellar-sdk';
import { User, ConsentAudit, RequestStatus, Role, PlatformType } from '@prisma/client';
import * as crypto from 'crypto';
import { WalletsService } from '../wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    @Optional()
    private readonly walletsService?: WalletsService,
  ) {}

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
    try {
      let authUser: any =
        typeof userOrId === 'object' && userOrId !== null ? userOrId : null;

      if (!authUser && typeof userOrId === 'string') {
        const supabaseClient = this.supabaseService.getClient();
        const { data, error } =
          await supabaseClient.auth.admin.getUserById(userOrId);
        if (error || !data?.user) {
          this.logger.warn(
            `autoProvisionFromAuth: user ${userOrId} not found in Supabase Auth`,
          );
          return null;
        }
        authUser = data.user;
      }

      if (!authUser || !authUser.id || !authUser.email) {
        return null;
      }

      // 1. Check if user already exists
      const existing = await this.prisma.user.findUnique({
        where: { id: authUser.id },
      });
      if (existing) {
        return existing;
      }

      // 2. Defend against stale records with same email but different ID
      const userByEmail = await this.prisma.user.findUnique({
        where: { email: authUser.email },
      });
      if (userByEmail && userByEmail.id !== authUser.id) {
        await this.prisma.user.update({
          where: { id: userByEmail.id },
          data: { email: `stale_${Date.now()}_${userByEmail.email}` },
        });
      }

      // 3. Determine role from user metadata or email prefix
      const rawRole = authUser.user_metadata?.role;
      let role: Role = Role.HOGAR;
      if (rawRole && Object.values(Role).includes(rawRole as Role)) {
        role = rawRole as Role;
      } else {
        const emailLower = authUser.email.toLowerCase();
        if (emailLower.includes('recolector')) role = Role.RECOLECTOR;
        else if (emailLower.includes('centro') || emailLower.includes('acopio'))
          role = Role.CENTRO_ACOPIO;
        else if (emailLower.includes('tienda')) role = Role.TIENDA;
        else if (emailLower.includes('empresa')) role = Role.EMPRESA_B2B;
        else if (emailLower.includes('admin')) role = Role.ADMIN;
      }

      const name =
        authUser.user_metadata?.name ||
        authUser.user_metadata?.full_name ||
        authUser.email.split('@')[0];

      // 4. Generate Web3 Stellar Keypair
      const pair = Keypair.random();
      const walletAddress = pair.publicKey();
      const privateKey = pair.secret();

      const encryptionKey =
        this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
        this.configService.get<string>('ENCRYPTION_KEY') ||
        'test_isolated_wallet_encryption_key_32c';

      const encryptedPrivateKey = CryptoUtil.encrypt(privateKey, encryptionKey);

      // 5. Create user record in PostgreSQL
      const newUser = await this.prisma.user.upsert({
        where: { id: authUser.id },
        update: {},
        create: {
          id: authUser.id,
          email: authUser.email,
          role,
          name,
          walletAddress,
          encryptedPrivateKey,
          marketingAccepted: false,
          isActive: true,
        },
      });

      // 6. If TIENDA, ensure StoreProfile exists
      if (role === Role.TIENDA) {
        const store = await this.prisma.storeProfile.findUnique({
          where: { userId: newUser.id },
        });
        if (!store) {
          await this.prisma.storeProfile
            .create({
              data: {
                userId: newUser.id,
                businessName: name || 'Tienda Aliada',
                ruc:
                  '20' +
                  Math.floor(100000000 + Math.random() * 900000000).toString(),
                address: 'Av. Principal 123',
                bankAccount: '000-00000000-0-00',
              },
            })
            .catch((err) =>
              this.logger.error(
                `Error creating StoreProfile in autoProvision: ${err.message}`,
              ),
            );
        }
      }

      if (process.env.NODE_ENV !== 'test') {
        this.userCache.set(newUser.id, { user: newUser, expires: Date.now() + 10000 });
      }

      this.logger.log(
        `Auto-provisioned local user ${newUser.id} (${newUser.email}) with role ${newUser.role}`,
      );
      return newUser;
    } catch (err: any) {
      this.logger.error(
        `Failed to auto-provision user: ${err.message}`,
        err.stack,
      );
      return null;
    }
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
      this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'CRITICAL SECURITY ERROR: La variable WALLET_ENCRYPTION_KEY es obligatoria para la custodia de claves Web3.',
      );
    }
    const finalKey = encryptionKey || 'test_isolated_wallet_encryption_key_32c';

    // Encriptar clave privada con AES-256-GCM
    const encryptedPrivateKey = CryptoUtil.encrypt(privateKey, finalKey);

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

      // 4. Anonimizar integralmente reclamos / quejas (Cumplimiento Ley 29733 - ANPD & Indecopi)
      await tx.complaint.updateMany({
        where: { userId: id },
        data: {
          documentNumber: '00000000',
          fullName: 'USUARIO ANONIMIZADO (ARCO)',
          address: 'ANONIMO',
          phone: '000000000',
          email: 'anonimo@anon.livora.pe',
          representativeName: null,
          representativeDoc: null,
          claimDetail:
            'Contenido suprimido por solicitud de cancelación ARCO (Ley 29733)',
          consumerRequest:
            'Contenido suprimido por solicitud de cancelación ARCO (Ley 29733)',
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
}
