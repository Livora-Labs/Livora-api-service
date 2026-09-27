-- CreateTable
CREATE TABLE "wallet_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "senderUserId" UUID NOT NULL,
    "receiverUserId" UUID,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_transfers_senderUserId_idx" ON "wallet_transfers"("senderUserId");

-- CreateIndex
CREATE INDEX "wallet_transfers_receiverUserId_idx" ON "wallet_transfers"("receiverUserId");

-- CreateIndex
CREATE INDEX "wallet_transfers_toAddress_idx" ON "wallet_transfers"("toAddress");

-- AddForeignKey
ALTER TABLE "wallet_transfers" ADD CONSTRAINT "wallet_transfers_senderUserId_fkey"
    FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transfers" ADD CONSTRAINT "wallet_transfers_receiverUserId_fkey"
    FOREIGN KEY ("receiverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
