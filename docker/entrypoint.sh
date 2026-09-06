#!/bin/sh
set -e

# Modo MIGRATION: Se ejecuta de forma aislada en el contenedor de migraciones
if [ "$APP_MODE" = "MIGRATION" ]; then
  echo "==> [Entrypoint] Modo MIGRATION detectado. Sincronizando esquema de base de datos..."
  npx prisma db push --accept-data-loss
  echo "==> [Entrypoint] Esquema sincronizado exitosamente."
  exit 0
fi

echo "==> [Entrypoint] Modo $APP_MODE detectado. Iniciando proceso de aplicación ($@)..."
exec "$@"
