FROM node:18-alpine

RUN apk add --no-cache python3 make g++ gcc musl-dev

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p database

EXPOSE 6666

CMD ["npm", "start"]
