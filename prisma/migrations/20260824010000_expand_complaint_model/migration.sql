-- AlterTable
ALTER TABLE "complaints"
    ADD COLUMN IF NOT EXISTS "correlativeNumber" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "documentType" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "documentNumber" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "fullName" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "address" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "phone" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "email" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "isMinor" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "representativeName" TEXT,
    ADD COLUMN IF NOT EXISTS "goodType" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "goodDescription" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "amount" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "claimType" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "claimDetail" TEXT NOT NULL,
    ADD COLUMN IF NOT EXISTS "consumerRequest" TEXT NOT NULL,
    ALTER COLUMN "userId" DROP NOT NULL,
    ALTER COLUMN "subject" DROP NOT NULL,
    ALTER COLUMN "description" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "complaints" DROP CONSTRAINT IF EXISTS "complaints_userId_fkey";

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "complaints_correlativeNumber_key" ON "complaints"("correlativeNumber");
CREATE INDEX IF NOT EXISTS "complaints_correlativeNumber_idx" ON "complaints"("correlativeNumber");
CREATE INDEX IF NOT EXISTS "complaints_email_idx" ON "complaints"("email");
CREATE INDEX IF NOT EXISTS "complaints_userId_idx" ON "complaints"("userId");
