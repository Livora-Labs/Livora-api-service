import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Keypair } from '@stellar/stellar-sdk';
import { CryptoUtil } from './common/utils/crypto.util';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log('Iniciando migración de billeteras a Stellar...');

  const users = await prisma.user.findMany();
  console.log(`Encontrados ${users.length} usuarios.`);

  const encryptionKey =
    process.env.WALLET_ENCRYPTION_KEY || 'livora_wallet_aes256_secret!';

  let migratedCount = 0;

  for (const user of users) {
    if (user.walletAddress && user.walletAddress.startsWith('0x')) {
      const pair = Keypair.random();
      const newAddress = pair.publicKey();
      const newSecret = pair.secret();
      const encryptedKey = CryptoUtil.encrypt(newSecret, encryptionKey);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          walletAddress: newAddress,
          encryptedPrivateKey: encryptedKey,
        },
      });

      console.log(
        `Usuario ${user.email} migrado: ${user.walletAddress} -> ${newAddress}`,
      );
      migratedCount++;
    }
  }

  console.log(`Migración completada. ${migratedCount} usuarios migrados.`);
}

run()
  .catch((err) => {
    console.error('Error durante la migración:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
