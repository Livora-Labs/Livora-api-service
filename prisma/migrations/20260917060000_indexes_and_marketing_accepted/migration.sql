-- ==============================================================================
-- MILESTONE 1 (WP-01): LEGAL COMPLIANCE & HIGH-PERFORMANCE B-TREE INDEXES
-- ==============================================================================

-- 1. Legal Compliance: marketingAccepted (Ley 29733)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketingAccepted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "consent_audits" ADD COLUMN IF NOT EXISTS "marketingAccepted" BOOLEAN NOT NULL DEFAULT false;

-- 2. Notification Indexes (Filtered queries by user and read state)
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");

-- 3. KycApplication Indexes (Verification status queues by user)
CREATE INDEX IF NOT EXISTS "kyc_applications_userId_status_idx" ON "kyc_applications"("userId", "status");
CREATE INDEX IF NOT EXISTS "kyc_applications_createdAt_idx" ON "kyc_applications"("createdAt");

-- 4. Sale Indexes (Acopio center filtering and time sorting)
CREATE INDEX IF NOT EXISTS "sales_centerId_idx" ON "sales"("centerId");
CREATE INDEX IF NOT EXISTS "sales_createdAt_idx" ON "sales"("createdAt");

-- 5. Certificate Indexes (Buyer company query and time sorting)
CREATE INDEX IF NOT EXISTS "certificates_buyerId_status_idx" ON "certificates"("buyerId", "status");
CREATE INDEX IF NOT EXISTS "certificates_createdAt_idx" ON "certificates"("createdAt");

-- 6. Batch & ConsolidatedBatch Indexes (Destination center queries and chronological tracking)
CREATE INDEX IF NOT EXISTS "batches_destinationCenterId_idx" ON "batches"("destinationCenterId");
CREATE INDEX IF NOT EXISTS "batches_createdAt_idx" ON "batches"("createdAt");
CREATE INDEX IF NOT EXISTS "consolidated_batches_centerId_idx" ON "consolidated_batches"("centerId");
CREATE INDEX IF NOT EXISTS "consolidated_batches_createdAt_idx" ON "consolidated_batches"("createdAt");
