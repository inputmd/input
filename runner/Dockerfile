FROM node:22-slim AS build

WORKDIR /build
RUN npm install --save-exact esbuild@0.25.2
COPY agent.ts .
RUN npx esbuild agent.ts --bundle --platform=node --target=node22 --outfile=agent.js

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /agent

COPY --from=build /build/agent.js .

RUN mkdir -p /workspace && \
    adduser --disabled-password --gecos '' runner && \
    chown -R runner:runner /workspace /agent

USER runner

ENV PORT=8080
ENV WORK_DIR=/workspace

EXPOSE 8080

CMD ["node", "agent.js"]
