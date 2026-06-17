FROM node:22-alpine

# docker-cli: docker stats | python3/make/g++: native addon compilation
RUN apk add --no-cache docker-cli python3 make g++

WORKDIR /app

RUN mkdir -p /app/data

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js admin.js db.js ./

EXPOSE 8081

CMD ["node", "server.js"]
