FROM node:22-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js .

EXPOSE 8081

CMD ["node", "server.js"]
