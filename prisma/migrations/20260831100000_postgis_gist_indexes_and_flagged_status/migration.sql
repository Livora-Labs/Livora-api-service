-- Enable PostGIS Extension if not exists
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add FLAGGED_FOR_REVIEW to BatchStatus enum
ALTER TYPE "BatchStatus" ADD VALUE IF NOT EXISTS 'FLAGGED_FOR_REVIEW';

-- Create GiST Spatial Index on collection_requests (longitude, latitude)
CREATE INDEX IF NOT EXISTS idx_collection_requests_location_gist 
  ON "collection_requests" USING GIST ((ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography));

-- Create GiST Spatial Index on users (centers, warehouses, households)
CREATE INDEX IF NOT EXISTS idx_users_location_gist 
  ON "users" USING GIST ((ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography))
  WHERE "longitude" IS NOT NULL AND "latitude" IS NOT NULL;
