FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

EXPOSE 5173
EXPOSE 3001

CMD ["sh", "-c", "bun ws-server.ts & bun run dev"]
