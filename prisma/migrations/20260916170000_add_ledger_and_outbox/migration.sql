-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER_WALLET', 'STORE_ESCROW', 'SYSTEM_MINTING_POOL', 'SYSTEM_BURNING_POOL', 'SYSTEM_ESCROW_HOLD');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "encryptionIv" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "encryptionTag" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "accounts" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "accountType" "AccountType" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LIVORA',
    "cachedBalance" DECIMAL(18,7) NOT NULL DEFAULT 0.0000000,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ledger_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,7) NOT NULL,
    "runningBalance" DECIMAL(18,7) NOT NULL,
    "correlationId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "outbox_events" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "accounts_accountType_idx" ON "accounts"("accountType");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_userId_currency_key" ON "accounts"("userId", "currency");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ledger_entries_accountId_createdAt_idx" ON "ledger_entries"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ledger_entries_correlationId_idx" ON "ledger_entries"("correlationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ledger_entries_txHash_idx" ON "ledger_entries"("txHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_status_createdAt_idx" ON "outbox_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
