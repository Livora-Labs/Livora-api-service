-- Purgar usuarios y registros existentes con rol ALMACEN
DELETE FROM "users" WHERE "role"::text = 'ALMACEN';

-- Modificar el tipo enum Role para remover ALMACEN de forma segura en PostgreSQL
CREATE TYPE "Role_new" AS ENUM ('HOGAR', 'RECOLECTOR', 'CENTRO_ACOPIO', 'EMPRESA_B2B', 'ADMIN', 'TIENDA');

ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");

DROP TYPE "Role";

ALTER TYPE "Role_new" RENAME TO "Role";
