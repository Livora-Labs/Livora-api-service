FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# npm install (no ci): el lockfile generado en macOS omite deps opcionales de Linux
RUN npm install

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Igual que en Render: db push sincroniza el esquema al arrancar
CMD ["sh", "-c", "npx prisma db push && node dist/src/main"]
