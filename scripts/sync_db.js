const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  console.log('Connected to PostgreSQL database...');

  await client.query(`
    DO $$ BEGIN
      CREATE TYPE "AssignmentMode" AS ENUM ('AUTOMATIC', 'AUCTION');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      CREATE TYPE "BidStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
      CREATE TYPE "BlockchainStatus" AS ENUM ('PENDING', 'MINTED', 'FAILED_BLOCKCHAIN');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;

    ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
    ALTER TYPE "BatchStatus" ADD VALUE IF NOT EXISTS 'FLAGGED_FOR_REVIEW';
  `);

  await client.query(`
    ALTER TABLE "collection_requests" 
    ADD COLUMN IF NOT EXISTS "assignmentMode" "AssignmentMode" NOT NULL DEFAULT 'AUTOMATIC',
    ADD COLUMN IF NOT EXISTS "actualWeights" JSONB,
    ADD COLUMN IF NOT EXISTS "assignedCenterId" UUID REFERENCES "users"("id"),
    ADD COLUMN IF NOT EXISTS "agreedRates" JSONB,
    ADD COLUMN IF NOT EXISTS "escrowLocked" DECIMAL(14, 4) NOT NULL DEFAULT 0;
  `);

  await client.query(`
    ALTER TABLE "complaints"
    ADD COLUMN IF NOT EXISTS "legalResponseNote" TEXT,
    ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "acopio_price_lists" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      "centerId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "materialType" TEXT NOT NULL,
      "pricePerKg" DECIMAL(10, 4) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "acopio_price_lists_centerId_materialType_key" UNIQUE ("centerId", "materialType")
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "acopio_bids" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      "requestId" UUID NOT NULL REFERENCES "collection_requests"("id") ON DELETE CASCADE,
      "centerId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "proposedRates" JSONB NOT NULL,
      "totalEstimatedPenn" DECIMAL(12, 2) NOT NULL,
      "totalEstimatedEco" DECIMAL(14, 4) NOT NULL,
      "status" "BidStatus" NOT NULL DEFAULT 'PENDING',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "payment_transactions" (
      "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "amountPen" DECIMAL(12, 2) NOT NULL,
      "tokenAmount" DECIMAL(14, 4) NOT NULL,
      "purchaseNumber" TEXT NOT NULL UNIQUE,
      "transactionToken" TEXT,
      "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
      "cardBrand" TEXT,
      "cardPanMasked" TEXT,
      "authorizationCode" TEXT,
      "actionCode" TEXT,
      "traceNumber" TEXT,
      "commissionPen" DECIMAL(12, 2),
      "igvPen" DECIMAL(12, 2),
      "receiptId" TEXT,
      "blockchainStatus" "BlockchainStatus" DEFAULT 'PENDING',
      "gatewayResponse" JSONB,
      "txHash" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE "payment_transactions"
    ADD COLUMN IF NOT EXISTS "cardBrand" TEXT,
    ADD COLUMN IF NOT EXISTS "cardPanMasked" TEXT,
    ADD COLUMN IF NOT EXISTS "authorizationCode" TEXT,
    ADD COLUMN IF NOT EXISTS "actionCode" TEXT,
    ADD COLUMN IF NOT EXISTS "traceNumber" TEXT,
    ADD COLUMN IF NOT EXISTS "commissionPen" DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS "igvPen" DECIMAL(12, 2),
    ADD COLUMN IF NOT EXISTS "receiptId" TEXT,
    ADD COLUMN IF NOT EXISTS "blockchainStatus" "BlockchainStatus" DEFAULT 'PENDING';
  `);

  await client.query(`
    -- Migración Decimal
    ALTER TABLE "redemption_transactions" 
      ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4);

    ALTER TABLE "settlement_requests" 
      ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4),
      ALTER COLUMN "fiatAmount" SET DATA TYPE DECIMAL(12, 2) USING "fiatAmount"::numeric(12, 2);

    ALTER TABLE "payment_transactions" 
      ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4),
      ALTER COLUMN "amountPen" SET DATA TYPE DECIMAL(12, 2) USING "amountPen"::numeric(12, 2);

    ALTER TABLE "acopio_bids" 
      ALTER COLUMN "totalEstimatedEco" SET DATA TYPE DECIMAL(14, 4) USING "totalEstimatedEco"::numeric(14, 4),
      ALTER COLUMN "totalEstimatedPenn" SET DATA TYPE DECIMAL(12, 2) USING "totalEstimatedPenn"::numeric(12, 2);

    ALTER TABLE "complaints" 
      ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12, 2) USING "amount"::numeric(12, 2);

    ALTER TABLE "sales" 
      ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(14, 2) USING "totalAmount"::numeric(14, 2),
      ALTER COLUMN "weightKg" SET DATA TYPE DECIMAL(12, 3) USING "weightKg"::numeric(12, 3);

    ALTER TABLE "acopio_price_lists" 
      ALTER COLUMN "pricePerKg" SET DATA TYPE DECIMAL(10, 4) USING "pricePerKg"::numeric(10, 4);

    ALTER TABLE "inventory_items" 
      ALTER COLUMN "quantityKg" SET DATA TYPE DECIMAL(14, 3) USING "quantityKg"::numeric(14, 3);

    ALTER TABLE "inventory_movements" 
      ALTER COLUMN "quantityKg" SET DATA TYPE DECIMAL(14, 3) USING "quantityKg"::numeric(14, 3);

    ALTER TABLE "consolidated_batches" 
      ALTER COLUMN "totalWeight" SET DATA TYPE DECIMAL(14, 3) USING "totalWeight"::numeric(14, 3);

    -- Índices
    CREATE INDEX IF NOT EXISTS "collection_requests_status_assignedCenterId_idx" 
      ON "collection_requests"("status", "assignedCenterId");

    CREATE INDEX IF NOT EXISTS "collection_requests_batchId_idx" 
      ON "collection_requests"("batchId");

    CREATE INDEX IF NOT EXISTS "collection_requests_collectorId_idx" 
      ON "collection_requests"("collectorId");

    CREATE INDEX IF NOT EXISTS "collection_requests_householdId_idx" 
      ON "collection_requests"("householdId");

    CREATE INDEX IF NOT EXISTS "batches_collectorId_status_idx" 
      ON "batches"("collectorId", "status");

    CREATE INDEX IF NOT EXISTS "batches_destinationCenterId_status_idx" 
      ON "batches"("destinationCenterId", "status");

    CREATE INDEX IF NOT EXISTS "batches_collectorId_destinationCenterId_status_idx" 
      ON "batches"("collectorId", "destinationCenterId", "status");

    CREATE INDEX IF NOT EXISTS "redemption_transactions_userId_status_idx" 
      ON "redemption_transactions"("userId", "status");

    CREATE INDEX IF NOT EXISTS "redemption_transactions_storeId_idx" 
      ON "redemption_transactions"("storeId");

    CREATE INDEX IF NOT EXISTS "acopio_bids_requestId_idx" 
      ON "acopio_bids"("requestId");

    CREATE INDEX IF NOT EXISTS "acopio_bids_centerId_idx" 
      ON "acopio_bids"("centerId");

    CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_centerId_materialType_key" 
      ON "inventory_items"("centerId", "materialType");

    CREATE INDEX IF NOT EXISTS "payment_transactions_userId_status_idx" 
      ON "payment_transactions"("userId", "status");
  `);

  console.log('✅ DB Schema synced successfully!');
  await client.end();
}

run().catch(e => {
  console.error('❌ Error syncing schema:', e);
  process.exit(1);
});
