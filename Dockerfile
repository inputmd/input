FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY src ./src
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
