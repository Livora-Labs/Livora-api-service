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

const STORES = [
  {
    email: 'tienda.miraflores@livora.pe',
    password: 'LivoraTienda2026!',
    name: 'EcoTienda Zero Waste Miraflores',
    businessName: 'EcoTienda Zero Waste S.A.C.',
    ruc: '20609876543',
    address: 'Av. José Larco 890, Miraflores, Lima',
    phone: '+51 956789012',
    bankAccount: '191-98765432-0-01 (BCP Soles)',
    products: [
      {
        name: 'Bolsa Reutilizable de Algodón Orgánico',
        description: 'Capacidad 15 kg, confeccionada en algodón 100% orgánico y biodegradable. Ideal para compras sin plástico.',
        tokenPrice: 12.0,
        fiatReferencePrice: 12.0,
        stock: 50,
        imageUrl: 'https://images.unsplash.com/photo-1597484662367-9b50bd679374?w=500',
      },
      {
        name: 'Botella Térmica de Acero Inoxidable (500ml)',
        description: 'Botella de doble pared al vacío. Mantiene bebidas frías por 24 horas y calientes por 12 horas. Libre de BPA.',
        tokenPrice: 28.0,
        fiatReferencePrice: 28.0,
        stock: 25,
        imageUrl: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=500',
      },
      {
        name: 'Pack 4 Cepillos de Dientes de Bambú Biodegradable',
        description: 'Cerdas suaves infusadas con carbón activado, mango 100% de bambú compostable en empaque reciclable.',
        tokenPrice: 15.0,
        fiatReferencePrice: 15.0,
        stock: 40,
        imageUrl: 'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=500',
      },
      {
        name: 'Set de Cubiertos de Bambú con Estuche',
        description: 'Incluye tenedor, cuchara, cuchillo, pajilla y cepillo limpiador en estuche de tela reutilizable para viajes.',
        tokenPrice: 18.0,
        fiatReferencePrice: 18.0,
        stock: 30,
        imageUrl: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=500',
      },
    ],
  },
  {
    email: 'tienda.sanisidro@livora.pe',
    password: 'LivoraTienda2026!',
    name: 'Mercado Verde San Isidro',
    businessName: 'Mercado Verde Orgánico S.A.C.',
    ruc: '20601234567',
    address: 'Calle Las Begonias 441, San Isidro, Lima',
    phone: '+51 987123456',
    bankAccount: '002-191001234567890-54 (BCP CCI)',
    products: [
      {
        name: 'Jabón Artesanal de Avena y Miel (100g)',
        description: 'Elaborado en frío con aceites vegetales puros, avena exfoliante y miel de abeja orgánica. Cero empaques plásticos.',
        tokenPrice: 8.0,
        fiatReferencePrice: 8.0,
        stock: 60,
        imageUrl: 'https://images.unsplash.com/photo-1607006311600-33471430268f?w=500',
      },
      {
        name: 'Shampoo Sólido Natural de Romero y Ortiga (80g)',
        description: 'Equivale a 3 botellas plásticas de 250ml. Fortalece el cuero cabelludo con ingredientes 100% naturales y veganos.',
        tokenPrice: 20.0,
        fiatReferencePrice: 20.0,
        stock: 35,
        imageUrl: 'https://images.unsplash.com/photo-1535585209827-a15fcdbc4c2d?w=500',
      },
      {
        name: 'Desodorante Natural en Barra (50g)',
        description: 'Fórmula sin aluminio, parabenos ni fragancias sintéticas. Con manteca de karité, óxido de zinc y aceites esenciales.',
        tokenPrice: 16.0,
        fiatReferencePrice: 16.0,
        stock: 20,
        imageUrl: 'https://images.unsplash.com/photo-1617897903246-719242758050?w=500',
      },
      {
        name: 'Vela Aromática de Cera de Soya en Frasco Reciclado',
        description: 'Aroma a lavanda y eucalipto silvestre. Mecha de algodón libre de plomo, combustión limpia de más de 40 horas.',
        tokenPrice: 22.0,
        fiatReferencePrice: 22.0,
        stock: 15,
        imageUrl: 'https://images.unsplash.com/photo-1603006905003-be475563bc59?w=500',
      },
    ],
  },
];

async function main() {
  console.log('====================================================================');
  console.log('[SEED STORES & PRODUCTS] Sembrando Tiendas y Productos en Producción');
  console.log('====================================================================\n');

  const encryptionKey =
    process.env.ENCRYPTION_MASTER_KEY ||
    process.env.WALLET_ENCRYPTION_KEY ||
    'livora_wallet_aes256_secret!';

  for (const storeData of STORES) {
    console.log(`--> Procesando tienda: ${storeData.name} (${storeData.email})...`);

    let dbUser = await prisma.user.findFirst({
      where: { email: { equals: storeData.email, mode: 'insensitive' } },
    });

    const keypair = Keypair.random();
    const encryptedKey = encryptPrivateKey(keypair.secret(), encryptionKey);
    const passwordHash = await bcrypt.hash(storeData.password, 12);

    if (dbUser) {
      console.log(`   ✔ Perfil en PostgreSQL encontrado (ID: ${dbUser.id})`);
      await prisma.user.update({
        where: { id: dbUser.id },
        data: {
          name: storeData.name,
          phone: storeData.phone,
          address: storeData.address,
          role: 'TIENDA',
          userStatus: 'ACTIVE',
          isActive: true,
        },
      });
    } else {
      const newUserId = crypto.randomUUID();
      dbUser = await prisma.user.create({
        data: {
          id: newUserId,
          email: storeData.email,
          name: storeData.name,
          phone: storeData.phone,
          address: storeData.address,
          role: 'TIENDA',
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

      console.log(`   ✔ Usuario creado en PostgreSQL (ID: ${dbUser.id})`);
    }

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
      },
    });

    // Perfil de Tienda
    let storeProfile = await prisma.storeProfile.findUnique({
      where: { userId: dbUser.id },
    });

    if (storeProfile) {
      await prisma.storeProfile.update({
        where: { id: storeProfile.id },
        data: {
          businessName: storeData.businessName,
          ruc: storeData.ruc,
          address: storeData.address,
          phone: storeData.phone,
          bankAccount: storeData.bankAccount,
        },
      });
      console.log(`   ✔ StoreProfile actualizado (ID: ${storeProfile.id})`);
    } else {
      storeProfile = await prisma.storeProfile.create({
        data: {
          userId: dbUser.id,
          businessName: storeData.businessName,
          ruc: storeData.ruc,
          address: storeData.address,
          phone: storeData.phone,
          bankAccount: storeData.bankAccount,
        },
      });
      console.log(`   ✔ StoreProfile creado (ID: ${storeProfile.id})`);
    }

    // Cuenta contable
    const userAccount = await prisma.account.findFirst({
      where: { userId: dbUser.id, currency: 'LIVORA' },
    });

    if (!userAccount) {
      await prisma.account.create({
        data: {
          userId: dbUser.id,
          accountType: 'USER_WALLET',
          currency: 'LIVORA',
          cachedBalance: 100,
        },
      });
      console.log('   ✔ Cuenta USER_WALLET inicializada con 100 LIVOs');
    }

    // Productos
    for (const prod of storeData.products) {
      const existingProduct = await prisma.product.findFirst({
        where: { storeId: storeProfile.id, name: prod.name },
      });

      if (!existingProduct) {
        await prisma.product.create({
          data: {
            storeId: storeProfile.id,
            name: prod.name,
            description: prod.description,
            tokenPrice: prod.tokenPrice,
            fiatReferencePrice: prod.fiatReferencePrice,
            stock: prod.stock,
            imageUrl: prod.imageUrl,
            isActive: true,
          },
        });
        console.log(`     + Producto creado: ${prod.name}`);
      } else {
        await prisma.product.update({
          where: { id: existingProduct.id },
          data: {
            stock: prod.stock,
            tokenPrice: prod.tokenPrice,
            isActive: true,
          },
        });
        console.log(`     ~ Producto actualizado: ${prod.name}`);
      }
    }
  }

  console.log('\n====================================================================');
  console.log('✔ Todas las tiendas y productos sembrados exitosamente');
  console.log('====================================================================');
}

main()
  .catch((e) => {
    console.error('Error fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
