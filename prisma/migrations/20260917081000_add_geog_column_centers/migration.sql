-- Add generated stored geography column to users for PostGIS spatial acceleration
ALTER TABLE "users" 
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326) 
  GENERATED ALWAYS AS (
    CASE 
      WHEN "longitude" IS NOT NULL AND "latitude" IS NOT NULL 
      THEN ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography 
      ELSE NULL 
    END
  ) STORED;

-- Create GiST index on geog column filtered for acopio centers
CREATE INDEX IF NOT EXISTS "idx_users_geog_acopio_gist" 
  ON "users" USING GIST ("geog") 
  WHERE "role" = 'CENTRO_ACOPIO' AND "deletedAt" IS NULL;
