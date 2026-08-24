-- AlterTable users
ALTER TABLE "users" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "consent_audits" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "documentHash" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE INDEX "consent_audits_userId_idx" ON "consent_audits"("userId");
CREATE INDEX "consent_audits_documentHash_idx" ON "consent_audits"("documentHash");

-- AddForeignKey
ALTER TABLE "consent_audits" ADD CONSTRAINT "consent_audits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
