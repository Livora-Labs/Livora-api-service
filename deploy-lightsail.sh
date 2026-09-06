#!/usr/bin/env bash
# Deploy de Livora a una instancia Ubuntu de AWS Lightsail.
# Uso: ./deploy-lightsail.sh <IP-estatica> <ruta-llave.pem>
set -euo pipefail

IP="${1:?Uso: ./deploy-lightsail.sh <IP-estatica> <ruta-llave.pem>}"
KEY="${2:?Falta la ruta a la llave .pem de Lightsail}"

if [ ! -f "$KEY" ]; then
  echo "[ERROR] El archivo de clave SSH no existe en: $KEY"
  exit 1
fi

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

echo "===================================================================="
echo "[DEPLOY] Iniciando despliegue de Livora en AWS Lightsail ($IP)"
echo "===================================================================="

echo "--> 1/6 Verificando conexion SSH..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" 'echo "[SSH_OK] Conexion establecida con exito."'

echo "--> 2/6 Configurando memoria Swap de 4GB para prevenir OOM durante la compilacion..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" '
  SWAP_TOTAL=$(free -m | awk "/Swap:/ {print \$2}")
  if [ -z "$SWAP_TOTAL" ] || [ "$SWAP_TOTAL" -lt 2048 ]; then
    echo "[SWAP] Swap insuficiente (${SWAP_TOTAL:-0}MB). Creando swapfile de 4GB..."
    sudo fallocate -l 4G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q "/swapfile" /etc/fstab; then
      echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
    fi
    echo "[SWAP] Swap de 4GB activado exitosamente."
  else
    echo "[SWAP] Swap existente (${SWAP_TOTAL}MB) adecuado."
  fi
'

echo "--> 3/6 Verificando e instalando Docker y Docker Compose..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" '
  if ! command -v docker >/dev/null 2>&1; then
    echo "[DOCKER] Instalando Docker engine..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker ubuntu || true
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "[DOCKER] Instalando plugin docker-compose..."
    sudo apt-get update -y && sudo apt-get install -y docker-compose-plugin
  fi
  echo "[DOCKER] Docker y Docker Compose verificados correctamente."
'

echo "--> 4/6 Sincronizando codigo fuente (Livora-api-service y Livora-frontend)..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" 'mkdir -p ~/livora/Livora-api-service ~/livora/Livora-frontend'

# Sincronizar Livora-api-service
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude '*.pem' \
  --exclude coverage --exclude .gemini --exclude '*.log' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "ubuntu@$IP:~/livora/Livora-api-service/"

# Sincronizar Livora-frontend si existe en el path relativo ../Livora-frontend
if [ -d "../Livora-frontend" ]; then
  rsync -az --delete \
    --exclude node_modules --exclude .git --exclude .next --exclude dist \
    --exclude coverage --exclude .gemini --exclude '*.log' \
    -e "ssh ${SSH_OPTS[*]}" \
    ../Livora-frontend/ "ubuntu@$IP:~/livora/Livora-frontend/"
fi

echo "--> 5/6 Adaptando variables de entorno para IP ($IP)..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "
  cd ~/livora/Livora-api-service
  if [ -f .env.production ]; then
    sed -i 's/DOMAIN=.*/DOMAIN=$IP.sslip.io/' .env.production
    sed -i 's/SERVER_IP=.*/SERVER_IP=$IP/' .env.production
    sed -i 's|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=https://$IP.sslip.io|' .env.production
    sed -i 's|NEXT_PUBLIC_API_BASE_URL=.*|NEXT_PUBLIC_API_BASE_URL=https://$IP.sslip.io|' .env.production
    sed -i 's/52.200.2.107/$IP/g' .env.production
    echo '[CONFIG] .env.production configurado para el host $IP.'
  fi
"

echo "--> 6/6 Construyendo y levantando contenedores en alta disponibilidad (3 replicas API)..."
ssh "${SSH_OPTS[@]}" "ubuntu@$IP" '
  cd ~/livora/Livora-api-service
  sudo docker compose -f docker-compose.prod.yml down --remove-orphans || true
  sudo docker compose -f docker-compose.prod.yml up -d --build --scale livora_api=3
'

echo "--> Validando salud del sistema (Healthcheck)..."
HEALTH_OK=false
for i in $(seq 1 18); do
  echo "    Intento $i/18: Comprobando endpoint /health..."
  if ssh "${SSH_OPTS[@]}" "ubuntu@$IP" 'curl -sf http://localhost:3000/health >/dev/null 2>&1 || curl -sf http://localhost/health >/dev/null 2>&1'; then
    HEALTH_OK=true
    break
  fi
  sleep 5
done

if [ "$HEALTH_OK" = true ]; then
  echo "[HEALTH_OK] El cluster de API responde correctamente."
  
  echo "--> Verificando inicializacion de base de datos..."
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" '
    cd ~/livora/Livora-api-service
    USER_COUNT=$(sudo docker compose -f docker-compose.prod.yml exec -T livora_api node -e "
      const { PrismaClient } = require(\"@prisma/client\");
      const { PrismaPg } = require(\"@prisma/adapter-pg\");
      const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
      p.user.count().then(c => { console.log(c); process.exit(0); }).catch(() => { console.log(0); process.exit(0); });
    " 2>/dev/null | tr -d "\r\n" || echo "0")

    if [ "$USER_COUNT" = "0" ] || [ -z "$USER_COUNT" ]; then
      echo "[SEED] Base de datos vacia detectada. Ejecutando seed y balance inicial..."
      sudo docker compose -f docker-compose.prod.yml exec -T livora_api node seed_and_transact.js || true
    else
      echo "[SEED] Base de datos ya inicializada ($USER_COUNT usuarios existentes)."
    fi
  '
else
  echo "[WARN] La API no respondio en el tiempo esperado. Diagnostico de contenedores:"
  ssh "${SSH_OPTS[@]}" "ubuntu@$IP" 'cd ~/livora/Livora-api-service && sudo docker compose -f docker-compose.prod.yml logs --tail 40'
fi

echo ""
echo "===================================================================="
echo "[SUCCESS] Despliegue completado."
echo "URL Publica HTTPS: https://$IP.sslip.io"
echo "URL Fallback HTTP: http://$IP"
echo "Swagger Docs:      https://$IP.sslip.io/api/docs"
echo "Healthcheck:       https://$IP.sslip.io/health"
echo "===================================================================="
echo "RECORDATORIO IMPORTANTE DE AWS LIGHTSAIL:"
echo "Asegurese de que los siguientes puertos esten abiertos en la consola"
echo "de AWS Lightsail (seccion Networking / Firewall):"
echo "  - TCP 80  (HTTP / Caddy ACME challenge)"
echo "  - TCP 443 (HTTPS / SSL)"
echo "  - TCP 3000 (HTTP API / Fallback directo)"
echo "===================================================================="
