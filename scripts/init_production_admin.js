const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { createClient } = require('@supabase/supabase-js');
const { Keypair } = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.join(__dirname, envFile) });

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
  console.log('[PURGE & INIT] Limpieza total de base de datos y creación de Administrador');
  console.log('====================================================================');

  const adminEmail = 'danielarmando023@gmail.com';
  const adminPassword = 'AdminLivora2026!*';

  // 1. Purgar todas las tablas en PostgreSQL
  console.log('--> 1. Purgando todas las tablas en PostgreSQL...');
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE 
      complaints, complaint_counters, consent_audits,
      redemption_transactions, settlement_requests, products, store_profiles,
      payment_transactions, b2b_transfers, sales,
      inventory_movements, inventory_items, consolidated_batches, batches,
      collection_requests, acopio_bids, acopio_price_lists,
      ledger_entries, accounts, certificates, dispute_cases,
      device_tokens, notifications, outbox_events, beta_signups,
      kyc_applications, users
    CASCADE;
  `);
  console.log('   ✔ Tablas purgadas exitosamente.');

  // 2. Limpiar usuarios antiguos en Supabase Auth
  console.log('--> 2. Sincronizando usuarios en Supabase Auth...');
  const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (userList?.users) {
    for (const u of userList.users) {
      console.log(`   Eliminando usuario antiguo de Supabase Auth: ${u.email}`);
      await supabase.auth.admin.deleteUser(u.id);
    }
  }

  // 3. Crear usuario administrador en Supabase Auth
  console.log(`--> 3. Creando nuevo usuario administrador en Supabase: ${adminEmail}...`);
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
  });

  if (authError || !authData?.user) {
    throw new Error(`Error creando administrador en Supabase: ${authError?.message}`);
  }
  const authUserId = authData.user.id;
  console.log(`   ✔ Administrador creado en Supabase Auth con ID: ${authUserId}`);

  // 4. Generar billetera Stellar cifrada
  console.log('--> 4. Generando clave criptográfica Stellar para el Administrador...');
  const keypair = Keypair.random();
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY || 'livora_wallet_aes256_secret!';
  const encryptedPrivateKey = encryptPrivateKey(keypair.secret(), encryptionKey);

  // 5. Crear usuario en PostgreSQL
  console.log('--> 5. Insertando perfil de Administrador en PostgreSQL...');
  const user = await prisma.user.create({
    data: {
      id: authUserId,
      email: adminEmail,
      fullName: 'Daniel Armando',
      phone: '+51987654321',
      address: 'Lima, Perú',
      role: 'ADMIN',
      status: 'ACTIVE',
      isEmailVerified: true,
      kycStatus: 'APPROVED',
      walletAddress: keypair.publicKey(),
      encryptedPrivateKey: encryptedPrivateKey,
      accounts: {
        create: {
          accountType: 'PRIMARY',
          currency: 'LIVORA',
          cachedBalance: 0,
        },
      },
    },
  });

  console.log('   ✔ Administrador insertado en la base de datos con éxito.');
  console.log('');
  console.log('====================================================================');
  console.log('[EXITO] Administrador creado correctamente:');
  console.log(`Email:       ${adminEmail}`);
  console.log(`Password:    ${adminPassword}`);
  console.log(`Rol:         ${user.role}`);
  console.log(`Wallet Pub:  ${user.walletAddress}`);
  console.log('====================================================================');
}

main()
  .catch((e) => {
    console.error('ERROR EN INIT:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
