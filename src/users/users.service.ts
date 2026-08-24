import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CryptoUtil } from '../common/utils/crypto.util';
import { Keypair } from '@stellar/stellar-sdk';
import { User, ConsentAudit } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
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
}
