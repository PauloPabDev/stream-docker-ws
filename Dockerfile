# Stage 1: compilar better-sqlite3 (addon nativo)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Stage 2: imagen de runtime — sin build tools, sin docker-cli
FROM node:22-alpine
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /app/node_modules ./node_modules
COPY server.js admin.js db.js ./
COPY views ./views
COPY public ./public
EXPOSE 8081
CMD ["node", "server.js"]
