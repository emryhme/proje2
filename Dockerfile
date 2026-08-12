# Node.js 20 LTS Alpine Image
FROM node:20-alpine AS builder

WORKDIR /app

# SQLite derlemesi için gerekli sistem paketleri
RUN apk add --no-cache python3 make g++ sqlite

# Bağımlılıkları yükle
COPY package*.json ./
RUN npm ci

# Kaynak kodları kopyala ve build al
COPY . .
RUN npm run build

# Production Image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/barons.db

# SQLite için runtime kütüphaneleri
RUN apk add --no-cache sqlite
RUN mkdir -p /data

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# SQLite Veritabanı ve Port
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
