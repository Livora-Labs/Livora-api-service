#!/usr/bin/env bash
# ==============================================================================
# Livora Database Automated Backup & Disaster Recovery (S3 / Supabase Storage)
# ==============================================================================
set -euo pipefail

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="${BACKUP_DIR:-/tmp/livora_backups}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-livora}"
DB_NAME="${DB_NAME:-livora_db}"
S3_BUCKET="${BACKUP_S3_BUCKET:-livora-database-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

BACKUP_FILENAME="livora_db_backup_${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILENAME}"

mkdir -p "${BACKUP_DIR}"

echo "📦 [$(date '+%Y-%m-%d %H:%M:%S')] Iniciando respaldo de PostgreSQL: ${DB_NAME} en ${DB_HOST}:${DB_PORT}..."

# 1. Ejecutar pg_dump y comprimir con gzip en streaming
PGPASSWORD="${DB_PASSWORD:-livora_secret}" pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -F c -b -v | gzip -9 > "${BACKUP_PATH}"

BACKUP_SIZE=$(du -h "${BACKUP_PATH}" | cut -f1)
echo "✅ Respaldo comprimido generado exitosamente: ${BACKUP_PATH} (Tamaño: ${BACKUP_SIZE})"

# 2. Subida a AWS S3 / Supabase Storage S3-compatible si AWS CLI o S3_ENDPOINT está configurado
if command -v aws &> /dev/null && [ -n "${S3_BUCKET}" ]; then
  echo "☁️ [$(date '+%Y-%m-%d %H:%M:%S')] Subiendo respaldo a S3: s3://${S3_BUCKET}/backups/${BACKUP_FILENAME}..."
  aws s3 cp "${BACKUP_PATH}" "s3://${S3_BUCKET}/backups/${BACKUP_FILENAME}" --storage-class STANDARD_IA
  echo "✅ Subida a S3 completada."
else
  echo "ℹ️ AWS CLI no disponible o bucket S3 no configurado. Respaldo conservado localmente en ${BACKUP_PATH}."
fi

# 3. Política de retención: Purgar respaldos locales con antigüedad superior a RETENTION_DAYS
echo "🧹 Limpiando respaldos locales con más de ${RETENTION_DAYS} días..."
find "${BACKUP_DIR}" -type f -name "livora_db_backup_*.sql.gz" -mtime +"${RETENTION_DAYS}" -exec rm -f {} +

echo "🏁 [$(date '+%Y-%m-%d %H:%M:%S')] Proceso de Disaster Recovery finalizado con éxito."
