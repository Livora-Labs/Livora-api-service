-- CreateTable: complaint_counters
CREATE TABLE IF NOT EXISTS "complaint_counters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "year" INTEGER NOT NULL,
    "type" VARCHAR(10) NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "complaint_counters_year_type_key" ON "complaint_counters"("year", "type");
CREATE INDEX IF NOT EXISTS "complaint_counters_year_type_idx" ON "complaint_counters"("year", "type");

-- Backfill / Pre-seed from existing complaints to ensure zero collisions with legacy data
INSERT INTO "complaint_counters" ("id", "year", "type", "last_value", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    sub.year,
    sub.type,
    sub.max_val,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        split_part("correlativeNumber", '-', 1) AS type,
        split_part("correlativeNumber", '-', 3)::INTEGER AS year,
        MAX(split_part("correlativeNumber", '-', 2)::INTEGER) AS max_val
    FROM "complaints"
    WHERE "correlativeNumber" ~ '^[RQ]-[0-9]+-[0-9]{4}$'
    GROUP BY split_part("correlativeNumber", '-', 1), split_part("correlativeNumber", '-', 3)::INTEGER
) sub
ON CONFLICT ("year", "type") 
DO UPDATE SET 
    "last_value" = GREATEST("complaint_counters"."last_value", EXCLUDED."last_value"),
    "updated_at" = CURRENT_TIMESTAMP;
