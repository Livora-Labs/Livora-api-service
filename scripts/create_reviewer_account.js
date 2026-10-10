const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Keypair } = require('@stellar/stellar-sdk');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;

function deriveKeyPbkdf2(secretKey, salt) {
  return crypto.pbkdf2Sync(
    String(secretKey),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );
}

function encryptPrivateKey(text, secretKey) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKeyPbkdf2(secretKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  key.fill(0);

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

async function main() {
  console.log('====================================================================');
  console.log('[REVIEWER ACCOUNT] Creación / Verificación de Cuenta para Google Play');
  console.log('====================================================================');

  const reviewerEmail = 'playstore.review@livora.pe';
  const reviewerPassword = 'LivoraReview2026!';
  const encryptionKey =
    process.env.ENCRYPTION_MASTER_KEY ||
    process.env.WALLET_ENCRYPTION_KEY ||
    'livora_wallet_aes256_secret!';

  // 1. Verificar o crear en PostgreSQL
  console.log(`--> 1. Verificando perfil en PostgreSQL (${reviewerEmail})...`);
  let dbUser = await prisma.user.findFirst({
    where: { email: { equals: reviewerEmail, mode: 'insensitive' } },
    include: { accounts: true },
  });

  const passwordHash = await bcrypt.hash(reviewerPassword, 12);

  if (dbUser) {
    console.log(`   ✔ Usuario encontrado en PostgreSQL (ID: ${dbUser.id})`);
    await prisma.user.update({
      where: { id: dbUser.id },
      data: { userStatus: 'ACTIVE', isActive: true },
    });

    // Actualizar credenciales Bcrypt
    await prisma.userCredential.upsert({
      where: { userId: dbUser.id },
      update: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastPasswordChange: new Date(),
      },
      create: {
        userId: dbUser.id,
        passwordHash,
        lastPasswordChange: new Date(),
      },
    });
    console.log('   ✔ Contraseña actualizada en UserCredential (Bcrypt)');

    if (dbUser.accounts.length === 0) {
      await prisma.account.create({
        data: {
          userId: dbUser.id,
          accountType: 'USER_WALLET',
          currency: 'LIVORA',
          cachedBalance: 50,
        },
      });
      console.log('   ✔ Cuenta USER_WALLET creada con 50 LIVOs');
    } else {
      await prisma.account.updateMany({
        where: { userId: dbUser.id },
        data: { cachedBalance: 50 },
      });
      console.log('   ✔ Saldo actualizado a 50 LIVOs');
    }
  } else {
    console.log('   --> Creando nuevo perfil en PostgreSQL...');
    const keypair = Keypair.random();
    const encryptedKey = encryptPrivateKey(keypair.secret(), encryptionKey);
    const newUserId = crypto.randomUUID();

    dbUser = await prisma.user.create({
      data: {
        id: newUserId,
        email: reviewerEmail,
        name: 'Google Play Reviewer',
        phone: '+51999888777',
        address: 'Av. Javier Prado Este 456, San Isidro, Lima',
        role: 'HOGAR',
        userStatus: 'ACTIVE',
        isActive: true,
        walletAddress: keypair.publicKey(),
        marketingAccepted: true,
      },
    });

    await prisma.walletVault.create({
      data: {
        userId: dbUser.id,
        encryptedPrivateKey: encryptedKey,
      },
    });

    await prisma.userCredential.create({
      data: {
        userId: dbUser.id,
        passwordHash,
      },
    });

    await prisma.account.create({
      data: {
        userId: dbUser.id,
        accountType: 'USER_WALLET',
        currency: 'LIVORA',
        cachedBalance: 50,
      },
    });
    console.log(`   ✔ Cuenta creada exitosamente con ID: ${dbUser.id} y 50 LIVOs`);
  }

  console.log('\n====================================================================');
  console.log('✔ Cuenta de revisor Google Play lista y operativa');
  console.log(`  Email: ${reviewerEmail}`);
  console.log(`  Password: ${reviewerPassword}`);
  console.log('====================================================================');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
