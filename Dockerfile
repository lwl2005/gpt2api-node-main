FROM node:18-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN rm -rf node_modules && npm ci --only=production

COPY . .

RUN mkdir -p database

EXPOSE 3000

CMD ["npm", "start"]
