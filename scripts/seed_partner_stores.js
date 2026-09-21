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
        name: 'Kit de Cubiertos de Bambú con Funda',
        description: 'Incluye tenedor, cuchillo, cuchara y sorbete de bambú natural con cepillo limpiador y funda de lino.',
        tokenPrice: 15.0,
        fiatReferencePrice: 15.0,
        stock: 30,
        imageUrl: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=500',
      },
    ],
  },
  {
    email: 'tienda.sanisidro@livora.pe',
    password: 'LivoraTienda2026!',
    name: 'GreenMarket Orgánicos San Isidro',
    businessName: 'GreenMarket Perú S.A.C.',
    ruc: '20712345678',
    address: 'Av. Conquistadores 450, San Isidro, Lima',
    phone: '+51 967890123',
    bankAccount: '193-45678901-0-22 (BCP Soles)',
    products: [
      {
        name: 'Pack x3 Jabones Artesanales Biodegradables',
        description: 'Elaborados a mano con aceites vegetales puros de oliva y coco. Hipoalergénicos y 100% biodegradables.',
        tokenPrice: 18.0,
        fiatReferencePrice: 18.0,
        stock: 40,
        imageUrl: 'https://images.unsplash.com/photo-1607006311600-31463945e2ef?w=500',
      },
      {
        name: 'Pack x2 Cepillos Dentales de Bambú Compostables',
        description: 'Mango ergonómico de bambú moso 100% compostable con cerdas suaves impregnadas en carbón activado.',
        tokenPrice: 10.0,
        fiatReferencePrice: 10.0,
        stock: 60,
        imageUrl: 'https://images.unsplash.com/photo-1607613009820-a29f7bb81c04?w=500',
      },
      {
        name: 'Shampoo Sólido Natural Romero y Menta (80g)',
        description: 'Fórmula concentrada botánica que rinde hasta 60 lavados. Sin sulfatos, parabenos ni envase plástico.',
        tokenPrice: 22.0,
        fiatReferencePrice: 22.0,
        stock: 35,
        imageUrl: 'https://images.unsplash.com/photo-1535585209827-a15fcdbc4c2d?w=500',
      },
    ],
  },
];

async function main() {
  console.log('====================================================================');
  console.log('[SEED STORES & PRODUCTS] Sembrando Tiendas y Productos en Producción');
  console.log('====================================================================\n');

  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY || 'livora_wallet_aes256_secret!';

  for (const storeData of STORES) {
    console.log(`--> Procesando tienda: ${storeData.name} (${storeData.email})...`);

    // 1. Supabase Auth
    const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    let authUser = userList?.users?.find(
      (u) => u.email?.toLowerCase() === storeData.email.toLowerCase()
    );

    let authUserId;
    if (authUser) {
      console.log(`   ✔ Usuario existente en Supabase Auth (ID: ${authUser.id})`);
      authUserId = authUser.id;
      await supabase.auth.admin.updateUserById(authUserId, {
        password: storeData.password,
        email_confirm: true,
      });
    } else {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: storeData.email,
        password: storeData.password,
        email_confirm: true,
      });
      if (createErr || !created?.user) {
        throw new Error(`Error en Supabase: ${createErr?.message}`);
      }
      authUserId = created.user.id;
      console.log(`   ✔ Usuario creado en Supabase Auth (ID: ${authUserId})`);
    }

    // 2. PostgreSQL User
    const keypair = Keypair.random();
    const encryptedKey = encryptPrivateKey(keypair.secret(), encryptionKey);

    let dbUser = await prisma.user.findFirst({
      where: { email: { equals: storeData.email, mode: 'insensitive' } },
    });

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
        },
      });
    } else {
      dbUser = await prisma.user.create({
        data: {
          id: authUserId,
          email: storeData.email,
          name: storeData.name,
          phone: storeData.phone,
          address: storeData.address,
          role: 'TIENDA',
          userStatus: 'ACTIVE',
          walletAddress: keypair.publicKey(),
          encryptedPrivateKey: encryptedKey,
          marketingAccepted: true,
        },
      });
      console.log(`   ✔ Perfil en PostgreSQL creado con wallet: ${keypair.publicKey()}`);
    }

    // 3. StoreProfile
    let storeProfile = await prisma.storeProfile.findUnique({
      where: { userId: dbUser.id },
    });

    if (storeProfile) {
      storeProfile = await prisma.storeProfile.update({
        where: { id: storeProfile.id },
        data: {
          businessName: storeData.businessName,
          ruc: storeData.ruc,
          address: storeData.address,
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
          bankAccount: storeData.bankAccount,
        },
      });
      console.log(`   ✔ StoreProfile creado (ID: ${storeProfile.id})`);
    }

    // 4. Products
    for (const prod of storeData.products) {
      const existingProd = await prisma.product.findFirst({
        where: { storeId: storeProfile.id, name: prod.name },
      });

      if (existingProd) {
        await prisma.product.update({
          where: { id: existingProd.id },
          data: {
            description: prod.description,
            tokenPrice: prod.tokenPrice,
            fiatReferencePrice: prod.fiatReferencePrice,
            stock: prod.stock,
            imageUrl: prod.imageUrl,
            isActive: true,
            productStatus: 'ACTIVE',
          },
        });
        console.log(`      * Producto actualizado: '${prod.name}' (${prod.tokenPrice} LIVOs)`);
      } else {
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
            productStatus: 'ACTIVE',
          },
        });
        console.log(`      * Producto creado: '${prod.name}' (${prod.tokenPrice} LIVOs, stock: ${prod.stock})`);
      }
    }
  }

  console.log('\n====================================================================');
  console.log('[COMPLETED] Todas las tiendas y productos han sido sembrados con éxito');
  console.log('====================================================================\n');
}

main()
  .catch((e) => {
    console.error('ERROR EN SEMBRADO DE TIENDAS:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
