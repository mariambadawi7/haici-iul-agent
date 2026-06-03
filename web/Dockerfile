FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

EXPOSE 5173
EXPOSE 3001

# Run the Bun.serve WebSocket relay (ws-server.ts) alongside the Vite dev
# server. Vite is the foreground process so the container's health tracks it.
CMD ["sh", "-c", "bun ws-server.ts & bun run dev"]
