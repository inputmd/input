FROM node:22-slim AS build
WORKDIR /app
ARG VITE_WEBCONTAINERS_API_KEY=""
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN VITE_WEBCONTAINERS_API_KEY="$VITE_WEBCONTAINERS_API_KEY" npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server ./server
COPY reader-ai ./reader-ai
COPY src ./src
COPY shared ./shared
COPY vendor ./vendor
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
