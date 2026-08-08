-- CreateEnum
CREATE TYPE "B2bTransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED');

-- AlterTable
ALTER TABLE "batches" ADD COLUMN     "ipfsCid" TEXT,
ADD COLUMN     "txHash" TEXT;

-- AlterTable
ALTER TABLE "redemption_transactions" ADD COLUMN     "txHash" TEXT;

-- CreateTable
CREATE TABLE "b2b_transfers" (
    "id" UUID NOT NULL,
    "materials" JSONB NOT NULL,
    "status" "B2bTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "buyerId" UUID NOT NULL,
    "centerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "b2b_transfers_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "b2b_transfers" ADD CONSTRAINT "b2b_transfers_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2b_transfers" ADD CONSTRAINT "b2b_transfers_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
