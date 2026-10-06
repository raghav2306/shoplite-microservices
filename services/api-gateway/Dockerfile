FROM node:20-alpine AS deps
WORKDIR /app
COPY services/api-gateway/package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app/services/api-gateway
COPY --from=deps /app/node_modules ./node_modules
COPY services/api-gateway/src ./src
COPY proto /app/proto
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1
CMD ["node", "src/index.js"]
