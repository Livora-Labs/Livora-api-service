import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CryptoUtil } from '../common/utils/crypto.util';
import { ethers } from 'ethers';
import { User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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

  async create(supabaseUserId: string, registerDto: RegisterDto): Promise<Omit<User, 'encryptedPrivateKey'>> {
    const existingUser = await this.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException('El correo electrónico ya se encuentra registrado');
    }

    // Generar billetera Web3 aleatoria con ethers.js
    const randomWallet = ethers.Wallet.createRandom();
    const walletAddress = randomWallet.address;
    const privateKey = randomWallet.privateKey;

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
}
