FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# npm install con --legacy-peer-deps para resolver compatibilidad con Nest 11
RUN npm install --legacy-peer-deps

COPY . .
RUN npx prisma generate && npm run build

# Entrypoint con permisos de ejecucion
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/bin/sh", "docker/entrypoint.sh"]

# Por defecto arranca el API Gateway (o el comando especificado en docker-compose)
CMD ["node", "dist/main.js"]
