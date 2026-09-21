const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { createClient } = require('@supabase/supabase-js');
const { Keypair } = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function encryptPrivateKey(text, secretKey) {
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

async function main() {
  console.log('====================================================================');
  console.log('[REVIEWER ACCOUNT] Creación / Verificación de Cuenta para Google Play');
  console.log('====================================================================');

  const reviewerEmail = 'playstore.review@livora.pe';
  const reviewerPassword = 'LivoraReview2026!';

  // 1. Verificar o crear en Supabase Auth
  console.log(`--> 1. Verificando usuario en Supabase Auth (${reviewerEmail})...`);
  const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  let existingAuthUser = userList?.users?.find(
    (u) => u.email?.toLowerCase() === reviewerEmail.toLowerCase()
  );

  let authUserId;
  if (existingAuthUser) {
    console.log(`   ✔ Usuario encontrado en Supabase Auth con ID: ${existingAuthUser.id}`);
    authUserId = existingAuthUser.id;
    await supabase.auth.admin.updateUserById(authUserId, {
      password: reviewerPassword,
      email_confirm: true,
    });
    console.log('   ✔ Contraseña actualizada en Supabase Auth');
  } else {
    console.log('   --> Creando usuario en Supabase Auth...');
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: reviewerEmail,
      password: reviewerPassword,
      email_confirm: true,
    });

    if (authError || !authData?.user) {
      throw new Error(`Error en Supabase: ${authError?.message}`);
    }
    authUserId = authData.user.id;
    console.log(`   ✔ Usuario creado en Supabase Auth con ID: ${authUserId}`);
  }

  // 2. Verificar o crear en PostgreSQL
  console.log('--> 2. Verificando perfil en PostgreSQL...');
  let dbUser = await prisma.user.findFirst({
    where: { email: { equals: reviewerEmail, mode: 'insensitive' } },
    include: { accounts: true },
  });

  if (dbUser) {
    console.log(`   ✔ Usuario encontrado en PostgreSQL (ID: ${dbUser.id})`);
    // Asegurar estado activo y balance
    await prisma.user.update({
      where: { id: dbUser.id },
      data: { userStatus: 'ACTIVE' },
    });
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
    const encryptionKey = process.env.WALLET_ENCRYPTION_KEY || 'livora_wallet_aes256_secret!';
    const encryptedPrivateKey = encryptPrivateKey(keypair.secret(), encryptionKey);

    dbUser = await prisma.user.create({
      data: {
        id: authUserId,
        email: reviewerEmail,
        name: 'Google Play Reviewer',
        phone: '+51999888777',
        address: 'Av. Javier Prado Este 456, San Isidro, Lima',
        role: 'HOGAR',
        userStatus: 'ACTIVE',
        walletAddress: keypair.publicKey(),
        encryptedPrivateKey: encryptedPrivateKey,
        accounts: {
          create: {
            accountType: 'USER_WALLET',
            currency: 'LIVORA',
            cachedBalance: 50,
          },
        },
      },
    });

    // Consentimiento Ley 29733
    await prisma.consentAudit.create({
      data: {
        userId: dbUser.id,
        ipAddress: '127.0.0.1',
        userAgent: 'GooglePlayReviewer/1.0',
        termsVersion: '1.0.0',
        privacyVersion: '1.0.0',
        marketingAccepted: false,
        documentHash: crypto
          .createHash('sha256')
          .update('Livora-Terms-1.0.0-Privacy-1.0.0')
          .digest('hex'),
        consentedAt: new Date(),
      },
    });
    console.log('   ✔ Perfil y consentimiento creados en PostgreSQL.');
  }

  console.log('====================================================================');
  console.log('[REVIEWER CREDENTIALS CONFIRMED]');
  console.log(`Email:       ${reviewerEmail}`);
  console.log(`Password:    ${reviewerPassword}`);
  console.log(`Rol:         HOGAR`);
  console.log(`Balance:     50 LIVOs`);
  console.log('====================================================================');
}

main()
  .catch((e) => {
    console.error('ERROR EN CREACION DE REVIEWER:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
