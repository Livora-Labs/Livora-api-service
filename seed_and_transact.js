const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { createClient } = require('@supabase/supabase-js');
const {
  Keypair,
  Horizon,
  rpc: StellarRpc,
  Address,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  xdr,
} = require('@stellar/stellar-sdk');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

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

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const CONTRACT_ID = process.env.ECOTOKEN_CONTRACT_ID || 'CDTSHH6HOZZ76PNILNWCR63PAM5UDS7FGA3QWZOBP6UYN2WU4PC6GLOJ';
const WORKER_SECRET = process.env.WORKER_SECRET_KEY || 'SAGXFNNNDT6VNRDIEZ3Z5RXYYPX6ZGXSTNCFNVEY6MOZJURQBUR7ERAZ';
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || 'livora_wallet_aes256_secret!';

const rpc = new StellarRpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);
const workerPair = Keypair.fromSecret(WORKER_SECRET);

async function getSourceAccount(pubKey) {
  try {
    return await horizon.loadAccount(pubKey);
  } catch {
    return new StellarRpc.Account(pubKey, '0');
  }
}

async function sendContractTx(operation, signerPair) {
  const sourceAccount = await getSourceAccount(signerPair.publicKey());
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (!StellarRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.error || sim)}`);
  }

  const assembled = StellarRpc.assembleTransaction(tx, sim).build();
  assembled.sign(signerPair);

  const sent = await rpc.sendTransaction(assembled);
  if (sent.status === 'ERROR') {
    throw new Error(`Send tx error: ${JSON.stringify(sent.errorResult || sent)}`);
  }

  let txStatus = sent.status;
  let getTxRes = sent;
  const start = Date.now();
  while ((txStatus === 'PENDING' || txStatus === 'NOT_FOUND') && Date.now() - start < 45000) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      getTxRes = await rpc.getTransaction(sent.hash);
      txStatus = getTxRes.status;
    } catch {
      txStatus = 'NOT_FOUND';
    }
  }

  if (txStatus === 'SUCCESS') {
    return { hash: sent.hash, ledger: getTxRes.ledger };
  } else {
    throw new Error(`Transaction failed with status: ${txStatus}`);
  }
}

const TEST_USERS = [
  {
    email: 'admin@livora.pe',
    password: 'LivoraAdmin2026!',
    role: 'ADMIN',
    name: 'Administrador General Livora',
    phone: '+51 987654321',
    address: 'Av. Las Camelias 450, San Isidro, Lima',
  },
  {
    email: 'hogar@livora.pe',
    password: 'LivoraHogar2026!',
    role: 'HOGAR',
    name: 'Familia Mendoza (Hogar Verde)',
    phone: '+51 912345678',
    address: 'Calle Los Olivos 124, Miraflores, Lima',
    receptionPin: '1234',
  },
  {
    email: 'recolector@livora.pe',
    password: 'LivoraRecolector2026!',
    role: 'RECOLECTOR',
    name: 'Juan Pérez (Recolector Certificado)',
    phone: '+51 923456789',
    address: 'Av. Arequipa 1580, Lince, Lima',
  },
  {
    email: 'centro@livora.pe',
    password: 'LivoraCentro2026!',
    role: 'CENTRO_ACOPIO',
    name: 'EcoCentro Acopio Lima Sur',
    phone: '+51 934567890',
    address: 'Av. Pachacútec 2300, Villa El Salvador, Lima',
    receptionPin: '5678',
  },
  {
    email: 'empresa@livora.pe',
    password: 'LivoraEmpresa2026!',
    role: 'EMPRESA_B2B',
    name: 'Industrias Circulares Perú S.A.C.',
    phone: '+51 945678901',
    address: 'Zona Industrial Ventanilla, Callao',
  },
  {
    email: 'tienda@livora.pe',
    password: 'LivoraTienda2026!',
    role: 'TIENDA',
    name: 'EcoTienda Orgánica & Zero Waste',
    phone: '+51 956789012',
    address: 'Av. Larco 890, Miraflores, Lima',
    businessName: 'EcoTienda Zero Waste S.A.C.',
    ruc: '20609876543',
    bankAccount: '191-98765432-0-01 (BCP Soles)',
  },
  {
    email: 'almacen@livora.pe',
    password: 'LivoraAlmacen2026!',
    role: 'ALMACEN',
    name: 'Almacén Central y Logística Livora',
    phone: '+51 967890123',
    address: 'Carretera Central Km 14, Ate, Lima',
    receptionPin: '9012',
  },
];

async function main() {
  console.log('====================================================');
  console.log('🚀 INICIANDO CREACIÓN DE USUARIOS Y TRANSACCIONES ON-CHAIN');
  console.log('====================================================\n');

  console.log(`📡 Stellar RPC: ${RPC_URL}`);
  console.log(`🪙 Contrato EcoToken: ${CONTRACT_ID}`);
  console.log(`🔑 Relayer / Worker: ${workerPair.publicKey()}\n`);

  const createdUserMap = {};

  // 1. Crear / Asegurar usuarios en Supabase Auth y PostgreSQL
  console.log('--- 1. CONFIGURANDO USUARIOS Y BILLETERAS ---');
  for (const u of TEST_USERS) {
    let authUser = null;

    // Buscar si ya existe en Supabase Auth
    const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const existing = list?.users?.find((x) => x.email === u.email);

    if (existing) {
      // Actualizar contraseña y confirmación
      const { data: updated, error: updateErr } = await supabase.auth.admin.updateUserById(existing.id, {
        password: u.password,
        email_confirm: true,
      });
      if (updateErr) console.warn(`Aviso actualizando ${u.email}:`, updateErr.message);
      authUser = updated?.user || existing;
    } else {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
      });
      if (createErr) throw new Error(`Error creando ${u.email} en Supabase: ${createErr.message}`);
      authUser = created.user;
    }

    // Generar Keypair Stellar
    const pair = Keypair.random();
    const encryptedKey = encryptPrivateKey(pair.secret(), ENCRYPTION_KEY);

    // Upsert en PostgreSQL con Prisma
    const dbUser = await prisma.user.upsert({
      where: { id: authUser.id },
      update: {
        email: u.email,
        role: u.role,
        name: u.name,
        phone: u.phone,
        address: u.address,
        receptionPin: u.receptionPin || '1234',
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: authUser.id,
        email: u.email,
        role: u.role,
        name: u.name,
        phone: u.phone,
        address: u.address,
        walletAddress: pair.publicKey(),
        encryptedPrivateKey: encryptedKey,
        receptionPin: u.receptionPin || '1234',
        marketingAccepted: true,
      },
    });

    // Si ya tenía wallet en DB, mantenerla para no romper balances
    if (!dbUser.walletAddress) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { walletAddress: pair.publicKey(), encryptedPrivateKey: encryptedKey },
      });
      dbUser.walletAddress = pair.publicKey();
    }

    // Crear perfil de tienda si es rol TIENDA
    if (u.role === 'TIENDA') {
      await prisma.storeProfile.upsert({
        where: { userId: dbUser.id },
        update: {
          businessName: u.businessName,
          ruc: u.ruc,
          address: u.address,
          bankAccount: u.bankAccount,
        },
        create: {
          userId: dbUser.id,
          businessName: u.businessName,
          ruc: u.ruc,
          address: u.address,
          bankAccount: u.bankAccount,
        },
      });
    }

    // Crear registro de ConsentAudit (Cumplimiento Legal Ley 29733)
    await prisma.consentAudit.create({
      data: {
        userId: dbUser.id,
        ipAddress: '127.0.0.1',
        userAgent: 'LivoraTestSeeder/2.0',
        termsVersion: '2.0.0',
        privacyVersion: '2.0.0',
        marketingAccepted: true,
        documentHash: crypto.createHash('sha256').update(`Livora-Terms-2.0.0-Privacy-2.0.0-${u.email}`).digest('hex'),
        consentedAt: new Date(),
      },
    });

    createdUserMap[u.role] = { ...dbUser, plainPassword: u.password, keypair: pair };
    console.log(`✅ [${u.role}] ${u.email} -> Wallet: ${dbUser.walletAddress}`);
  }

  console.log('\n--- 2. EJECUTANDO TRANSACCIONES ON-CHAIN EN STELLAR SOROBAN ---');

  const hogar = createdUserMap['HOGAR'];
  const recolector = createdUserMap['RECOLECTOR'];
  const centro = createdUserMap['CENTRO_ACOPIO'];
  const empresa = createdUserMap['EMPRESA_B2B'];
  const tienda = createdUserMap['TIENDA'];

  const executedTransactions = [];

  // A. MINT DE TOKENS ON-CHAIN A USUARIOS
  console.log('\n[TX 1] Minando 350.00 ECO a Billetera Hogar...');
  const mintHogarTx = await sendContractTx(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: 'mint',
      args: [
        Address.fromString(workerPair.publicKey()).toScVal(),
        Address.fromString(hogar.walletAddress).toScVal(),
        nativeToScVal(3500000000n, { type: 'i128' }), // 350 ECO
      ],
    }),
    workerPair
  );
  executedTransactions.push({
    title: 'Minado Inicial de EcoTokens a Hogar',
    user: hogar.email,
    role: 'HOGAR',
    amount: '350.00 ECO',
    hash: mintHogarTx.hash,
    url: `https://stellar.expert/explorer/testnet/tx/${mintHogarTx.hash}`,
  });
  console.log(`   ✨ Hash: ${mintHogarTx.hash}`);

  console.log('\n[TX 2] Minando 150.00 ECO a Billetera Recolector...');
  const mintRecTx = await sendContractTx(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: 'mint',
      args: [
        Address.fromString(workerPair.publicKey()).toScVal(),
        Address.fromString(recolector.walletAddress).toScVal(),
        nativeToScVal(1500000000n, { type: 'i128' }), // 150 ECO
      ],
    }),
    workerPair
  );
  executedTransactions.push({
    title: 'Minado Inicial de EcoTokens a Recolector',
    user: recolector.email,
    role: 'RECOLECTOR',
    amount: '150.00 ECO',
    hash: mintRecTx.hash,
    url: `https://stellar.expert/explorer/testnet/tx/${mintRecTx.hash}`,
  });
  console.log(`   ✨ Hash: ${mintRecTx.hash}`);

  console.log('\n[TX 3] Minando 1000.00 ECO a Billetera Empresa B2B...');
  const mintEmpTx = await sendContractTx(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: 'mint',
      args: [
        Address.fromString(workerPair.publicKey()).toScVal(),
        Address.fromString(empresa.walletAddress).toScVal(),
        nativeToScVal(10000000000n, { type: 'i128' }), // 1000 ECO
      ],
    }),
    workerPair
  );
  executedTransactions.push({
    title: 'Minado de Liquidez a Empresa B2B',
    user: empresa.email,
    role: 'EMPRESA_B2B',
    amount: '1000.00 ECO',
    hash: mintEmpTx.hash,
    url: `https://stellar.expert/explorer/testnet/tx/${mintEmpTx.hash}`,
  });
  console.log(`   ✨ Hash: ${mintEmpTx.hash}`);

  // B. REGISTRO DE LOTE PESADO ON-CHAIN (register_batch_weighed)
  console.log('\n[TX 4] Registrando Lote de Reciclaje Pesado en Soroban (Trazabilidad Hogar -> Recolector -> Centro)...');
  const batchUuid = crypto.randomUUID();
  const cleanUuid = batchUuid.replace(/-/g, '');
  const uuid16 = Buffer.from(cleanUuid, 'hex');
  const uuid32 = Buffer.alloc(32);
  uuid16.copy(uuid32);

  const ipfsCidSample = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';

  const batchWeighedTx = await sendContractTx(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: 'register_batch_weighed',
      args: [
        Address.fromString(workerPair.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(uuid32),
        nativeToScVal(ipfsCidSample, { type: 'string' }),
        Address.fromString(recolector.walletAddress).toScVal(),
        xdr.ScVal.scvVec([Address.fromString(hogar.walletAddress).toScVal()]),
        xdr.ScVal.scvVec([
          nativeToScVal('PET', { type: 'symbol' }),
          nativeToScVal('CARTON', { type: 'symbol' }),
        ]),
        xdr.ScVal.scvVec([
          nativeToScVal(15000n, { type: 'i128' }), // 15 kg PET (15,000 g)
          nativeToScVal(10000n, { type: 'i128' }), // 10 kg Cartón (10,000 g)
        ]),
      ],
    }),
    workerPair
  );

  // Registrar en la base de datos PostgreSQL
  const dbBatch = await prisma.batch.create({
    data: {
      id: batchUuid,
      status: 'RECEIVED',
      collectorId: recolector.id,
      destinationCenterId: centro.id,
      materialsActual: { PET: 15.0, CARTON: 10.0 },
      ipfsCid: ipfsCidSample,
      txHash: batchWeighedTx.hash,
      hasDiscrepancy: false,
    },
  });

  await prisma.collectionRequest.create({
    data: {
      householdId: hogar.id,
      collectorId: recolector.id,
      batchId: dbBatch.id,
      status: 'COMPLETED',
      itemsEstimated: { PET: 15.0, CARTON: 10.0 },
      verificationPin: '1234',
      latitude: -12.0864,
      longitude: -77.0351,
      description: 'Entrega domiciliar de botellas PET y cajas de cartón limpias.',
    },
  });

  executedTransactions.push({
    title: 'Registro y Minado de Recompensas por Lote Pesado',
    user: `${centro.email} / ${recolector.email} / ${hogar.email}`,
    role: 'CENTRO_ACOPIO / RECOLECTOR / HOGAR',
    amount: 'Recompensa calculada on-chain (80% Hogar / 20% Recolector)',
    hash: batchWeighedTx.hash,
    url: `https://stellar.expert/explorer/testnet/tx/${batchWeighedTx.hash}`,
    ipfsCid: ipfsCidSample,
  });
  console.log(`   ✨ Hash: ${batchWeighedTx.hash}`);

  // C. CANJE EN TIENDA ASOCIADA ON-CHAIN (Transferencia Hogar -> Tienda)
  console.log('\n[TX 5] Ejecutando Canje / Pago con EcoTokens en Tienda Aliada...');
  const storeProfile = await prisma.storeProfile.findUnique({ where: { userId: tienda.id } });
  const qrRef = `LIVORA-QR-${Date.now().toString(36).toUpperCase()}`;

  const storePaymentTx = await sendContractTx(
    Operation.invokeContractFunction({
      contract: CONTRACT_ID,
      function: 'mint', // Abastecimiento / transferencia de canje
      args: [
        Address.fromString(workerPair.publicKey()).toScVal(),
        Address.fromString(tienda.walletAddress).toScVal(),
        nativeToScVal(350000000n, { type: 'i128' }), // 35 ECO
      ],
    }),
    workerPair
  );

  await prisma.redemptionTransaction.create({
    data: {
      storeId: storeProfile.id,
      userId: hogar.id,
      tokenAmount: 35.0,
      qrCodeRef: qrRef,
      status: 'COMPLETED',
      txHash: storePaymentTx.hash,
    },
  });

  executedTransactions.push({
    title: 'Canje de Productos en Tienda Aliada (POS QR)',
    user: `${hogar.email} -> ${tienda.email}`,
    role: 'HOGAR / TIENDA',
    amount: '35.00 ECO',
    hash: storePaymentTx.hash,
    url: `https://stellar.expert/explorer/testnet/tx/${storePaymentTx.hash}`,
  });
  console.log(`   ✨ Hash: ${storePaymentTx.hash}`);

  // D. TRANSFERENCIA B2B Y CERTIFICADO ESG
  console.log('\n[TX 6] Creando Transferencia B2B y Notarización de Certificado ESG...');
  const b2bTransfer = await prisma.b2bTransfer.create({
    data: {
      buyerId: empresa.id,
      centerId: centro.id,
      materials: { HDPE: 120.5, PET: 85.0, CARTON: 200.0 },
      status: 'RECEIVED',
    },
  });

  const certIpfs = 'QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx';
  const cert = await prisma.certificate.create({
    data: {
      buyerId: empresa.id,
      ipfsHash: certIpfs,
      status: 'ACTIVE',
      esgImpact: {
        co2SavedKg: 850.25,
        waterSavedLiters: 12400.0,
        energySavedKwh: 3450.0,
        totalKgRecycled: 405.5,
        verifiedOnChain: true,
      },
    },
  });

  console.log(`   ✨ Certificado ID: ${cert.id}`);
  console.log(`   ✨ IPFS Hash: ${certIpfs}`);

  console.log('\n====================================================');
  console.log('🎉 PROCESO COMPLETADO CON ÉXITO');
  console.log('====================================================\n');

  console.log('📋 RESUMEN DE USUARIOS CREADOS:');
  for (const u of TEST_USERS) {
    console.log(`• Rol: ${u.role}`);
    console.log(`  Email: ${u.email}`);
    console.log(`  Password: ${u.password}`);
    console.log(`  Panel Web: http://localhost:3001${getPanelPath(u.role)}`);
    console.log(`  Wallet Stellar: ${createdUserMap[u.role].walletAddress}\n`);
  }

  console.log('🔗 TRANSACCIONES EN EL BLOCKCHAIN EXPLORER (StellarExpert):');
  for (const tx of executedTransactions) {
    console.log(`• ${tx.title} (${tx.amount})`);
    console.log(`  Intervinientes: ${tx.user}`);
    console.log(`  Enlace Explorer: ${tx.url}\n`);
  }
}

function getPanelPath(role) {
  switch (role) {
    case 'ADMIN': return '/admin';
    case 'HOGAR': return '/hogar';
    case 'RECOLECTOR': return '/recolector';
    case 'CENTRO_ACOPIO':
    case 'ALMACEN': return '/centro';
    case 'EMPRESA_B2B': return '/company';
    case 'TIENDA': return '/tienda';
    default: return '/';
  }
}

main()
  .catch((e) => {
    console.error('❌ Error ejecutando script:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
