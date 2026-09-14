FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY .npmrc ./
COPY prisma ./prisma
# npm install (no ci): el lockfile generado en macOS omite deps opcionales de Linux.
# .npmrc fija legacy-peer-deps=true (nestjs-throttler-storage-redis aún declara peer NestJS 10).
RUN npm install

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Igual que en Render: db push sincroniza el esquema al arrancar.
# --accept-data-loss: entorno testnet/QA con flujo db-push; evita crash-loop
# cuando el esquema evoluciona (p.ej. constraints nuevas). Revisar para prod real.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/src/main"]
