#!/usr/bin/env bash
# Deploy de Livora API a una instancia Ubuntu de AWS Lightsail.
# Uso: ./deploy-lightsail.sh <IP-estatica> <ruta-llave.pem>
set -euo pipefail

IP="${1:?Uso: ./deploy-lightsail.sh <IP-estatica> <ruta-llave.pem>}"
KEY="${2:?Falta la ruta a la llave .pem de Lightsail}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)

echo "==> 1/3 Instalando Docker en el servidor (si no existe)..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" \
  'command -v docker >/dev/null 2>&1 || (curl -fsSL https://get.docker.com | sudo sh)'

echo "==> 2/3 Sincronizando código..."
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude '*.pem' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "ubuntu@$IP:~/livora/"

echo "==> 3/3 Construyendo y levantando contenedores..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" \
  'cd ~/livora && sudo docker compose -f docker-compose.prod.yml up -d --build'

echo ""
echo "Listo. API disponible en: http://$IP  (Swagger: http://$IP/api/docs)"
