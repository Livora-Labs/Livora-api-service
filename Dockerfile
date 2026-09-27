# ==========================================
# STAGE 1: Build & Dependencies
# ==========================================
FROM node:22-slim AS builder

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

# Instalacion limpia con dependencias de desarrollo para compilar
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY . .

# Generar Prisma Client y compilar NestJS
RUN npx prisma generate && npm run build

# Poda de dependencias para dejar solo las de produccion y asegurar binario de Prisma
RUN npm prune --omit=dev --legacy-peer-deps && npm install prisma@7.9.1 --save-prod --legacy-peer-deps

# ==========================================
# STAGE 2: Minimal Production Runtime
# ==========================================
FROM node:22-slim AS runner

RUN apt-get update -y && apt-get install -y openssl dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Crear usuario y grupo seguro no-root
RUN groupadd --gid 1001 nodejs && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nestjs

# Copiar artefactos esenciales desde builder
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --chown=nestjs:nodejs docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x ./docker/entrypoint.sh

USER nestjs

EXPOSE 3000

# Usar dumb-init para gestionar senales UNIX adecuadamente
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/bin/sh", "docker/entrypoint.sh"]

CMD ["node", "dist/main.js"]
