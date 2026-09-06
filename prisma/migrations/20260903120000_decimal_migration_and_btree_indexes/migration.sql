-- =========================================================
-- MIGRACIÓN DE TIPOS FLOAT A DECIMAL (PRECISIÓN FINANCIERA Y PESAJE)
-- =========================================================

-- 1. EcoTokens (SEP-41) Decimal(14, 4)
ALTER TABLE "collection_requests" 
  ALTER COLUMN "escrowLocked" SET DATA TYPE DECIMAL(14, 4) USING "escrowLocked"::numeric(14, 4);

ALTER TABLE "redemption_transactions" 
  ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4);

ALTER TABLE "settlement_requests" 
  ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4);

ALTER TABLE "payment_transactions" 
  ALTER COLUMN "tokenAmount" SET DATA TYPE DECIMAL(14, 4) USING "tokenAmount"::numeric(14, 4);

ALTER TABLE "acopio_bids" 
  ALTER COLUMN "totalEstimatedEco" SET DATA TYPE DECIMAL(14, 4) USING "totalEstimatedEco"::numeric(14, 4);

-- 2. Moneda Fiat PEN Decimal(12, 2)
ALTER TABLE "settlement_requests" 
  ALTER COLUMN "fiatAmount" SET DATA TYPE DECIMAL(12, 2) USING "fiatAmount"::numeric(12, 2);

ALTER TABLE "payment_transactions" 
  ALTER COLUMN "amountPen" SET DATA TYPE DECIMAL(12, 2) USING "amountPen"::numeric(12, 2);

ALTER TABLE "acopio_bids" 
  ALTER COLUMN "totalEstimatedPenn" SET DATA TYPE DECIMAL(12, 2) USING "totalEstimatedPenn"::numeric(12, 2);

ALTER TABLE "complaints" 
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12, 2) USING "amount"::numeric(12, 2);

ALTER TABLE "sales" 
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(14, 2) USING "totalAmount"::numeric(14, 2);

-- 3. Tarifas Unitarias Decimal(10, 4)
ALTER TABLE "acopio_price_lists" 
  ALTER COLUMN "pricePerKg" SET DATA TYPE DECIMAL(10, 4) USING "pricePerKg"::numeric(10, 4);

-- 4. Pesajes Industriales Báscula (kg) Decimal(12, 3) / Decimal(14, 3)
ALTER TABLE "sales" 
  ALTER COLUMN "weightKg" SET DATA TYPE DECIMAL(12, 3) USING "weightKg"::numeric(12, 3);

ALTER TABLE "inventory_items" 
  ALTER COLUMN "quantityKg" SET DATA TYPE DECIMAL(14, 3) USING "quantityKg"::numeric(14, 3);

ALTER TABLE "inventory_movements" 
  ALTER COLUMN "quantityKg" SET DATA TYPE DECIMAL(14, 3) USING "quantityKg"::numeric(14, 3);

ALTER TABLE "consolidated_batches" 
  ALTER COLUMN "totalWeight" SET DATA TYPE DECIMAL(14, 3) USING "totalWeight"::numeric(14, 3);

-- =========================================================
-- ÍNDICES B-TREE ESTRATÉGICOS
-- =========================================================

-- CollectionRequest
CREATE INDEX IF NOT EXISTS "collection_requests_status_assignedCenterId_idx" 
  ON "collection_requests"("status", "assignedCenterId");

CREATE INDEX IF NOT EXISTS "collection_requests_batchId_idx" 
  ON "collection_requests"("batchId");

CREATE INDEX IF NOT EXISTS "collection_requests_collectorId_idx" 
  ON "collection_requests"("collectorId");

CREATE INDEX IF NOT EXISTS "collection_requests_householdId_idx" 
  ON "collection_requests"("householdId");

-- Batch (Segmentación por acopio y estado)
CREATE INDEX IF NOT EXISTS "batches_collectorId_status_idx" 
  ON "batches"("collectorId", "status");

CREATE INDEX IF NOT EXISTS "batches_destinationCenterId_status_idx" 
  ON "batches"("destinationCenterId", "status");

CREATE INDEX IF NOT EXISTS "batches_collectorId_destinationCenterId_status_idx" 
  ON "batches"("collectorId", "destinationCenterId", "status");

-- RedemptionTransaction
CREATE INDEX IF NOT EXISTS "redemption_transactions_userId_status_idx" 
  ON "redemption_transactions"("userId", "status");

CREATE INDEX IF NOT EXISTS "redemption_transactions_storeId_idx" 
  ON "redemption_transactions"("storeId");

-- AcopioBid
CREATE INDEX IF NOT EXISTS "acopio_bids_requestId_idx" 
  ON "acopio_bids"("requestId");

CREATE INDEX IF NOT EXISTS "acopio_bids_centerId_idx" 
  ON "acopio_bids"("centerId");

-- InventoryItem
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_centerId_materialType_key" 
  ON "inventory_items"("centerId", "materialType");

-- PaymentTransaction
CREATE INDEX IF NOT EXISTS "payment_transactions_userId_status_idx" 
  ON "payment_transactions"("userId", "status");
