const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const {
  Keypair,
  Horizon,
  rpc: StellarRpc,
  Address,
  TransactionBuilder,
  Operation,
  nativeToScVal,
} = require('@stellar/stellar-sdk');
const dotenv = require('dotenv');
const path = require('path');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
dotenv.config({ path: path.join(__dirname, '..', envFile) });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const WORKER_SECRET = process.env.WORKER_SECRET_KEY;
const CONTRACT_ID = process.env.ECOTOKEN_CONTRACT_ID || 'CDTSHH6HOZZ76PNILNWCR63PAM5UDS7FGA3QWZOBP6UYN2WU4PC6GLOJ';

if (!WORKER_SECRET) {
  console.error('FATAL: WORKER_SECRET_KEY is missing');
  process.exit(1);
}

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
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(45)
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
    await new Promise((r) => setTimeout(r, 2000));
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

async function main() {
  const targetEmail = 'huarique51@gmail.com';
  const amountToMint = 10.0;
  const amountStroops = 100000000n; // 10 * 10^7

  console.log('====================================================');
  console.log(`[MINT LIVOS] Minando ${amountToMint} LIVOs para ${targetEmail}`);
  console.log('====================================================\n');

  // 1. Buscar usuario en PostgreSQL
  const user = await prisma.user.findFirst({
    where: { email: { equals: targetEmail, mode: 'insensitive' } },
    include: { accounts: true },
  });

  if (!user) {
    throw new Error(`No se encontró el usuario con email: ${targetEmail}`);
  }

  console.log(`✔ Usuario encontrado: ${user.name || user.email} (ID: ${user.id})`);
  console.log(`✔ Wallet Stellar: ${user.walletAddress}`);

  if (!user.walletAddress) {
    throw new Error(`El usuario ${targetEmail} no tiene una dirección de billetera configurada.`);
  }

  // 2. Ejecutar transacción de Mint en Soroban
  console.log(`--> Transmitiendo mint(${amountToMint} LIVOs) a Soroban...`);
  console.log(`    Contrato: ${CONTRACT_ID}`);
  console.log(`    Destino:  ${user.walletAddress}`);

  let txResult;
  try {
    txResult = await sendContractTx(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: 'mint',
        args: [
          Address.fromString(workerPair.publicKey()).toScVal(),
          Address.fromString(user.walletAddress).toScVal(),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ],
      }),
      workerPair
    );
    console.log(`✔ Mint on-chain exitoso! Hash: ${txResult.hash}`);
    console.log(`  Ver en Explorer: https://stellar.expert/explorer/testnet/tx/${txResult.hash}`);
  } catch (err) {
    console.warn(`Aviso al minar on-chain: ${err.message}`);
  }

  // 3. Actualizar / Crear saldo en PostgreSQL (accounts)
  const existingAccount = user.accounts.find((a) => a.accountType === 'USER_WALLET');
  let newBalance = amountToMint;

  if (existingAccount) {
    newBalance = Number(existingAccount.cachedBalance || 0) + amountToMint;
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { cachedBalance: newBalance },
    });
    console.log(`✔ Saldo actualizado en PostgreSQL: ${newBalance.toFixed(2)} LIVOs`);
  } else {
    await prisma.account.create({
      data: {
        userId: user.id,
        accountType: 'USER_WALLET',
        currency: 'LIVORA',
        cachedBalance: newBalance,
      },
    });
    console.log(`✔ Cuenta USER_WALLET creada con saldo: ${newBalance.toFixed(2)} LIVOs`);
  }

  // 4. Crear registro en LedgerEntry si existe
  try {
    await prisma.ledgerEntry.create({
      data: {
        accountId: existingAccount?.id || (await prisma.account.findFirst({ where: { userId: user.id } })).id,
        entryType: 'CREDIT',
        amount: amountToMint,
        balanceAfter: newBalance,
        concept: 'RECOMPENSA_ADMIN_MINT',
        referenceId: txResult?.hash || `MANUAL-MINT-${Date.now()}`,
      },
    });
    console.log('✔ Entrada contable LedgerEntry registrada.');
  } catch (e) {
    console.log('Aviso registrando LedgerEntry (opcional):', e.message);
  }

  console.log('\n====================================================');
  console.log(`[SUCCESS] Se minaron exitosamente ${amountToMint} LIVOs a ${targetEmail}`);
  console.log(`Nuevo Saldo Total: ${newBalance.toFixed(2)} LIVOs`);
  if (txResult?.hash) {
    console.log(`TxHash: ${txResult.hash}`);
  }
  console.log('====================================================\n');
}

main()
  .catch((e) => {
    console.error('[ERROR] Error en mint:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
