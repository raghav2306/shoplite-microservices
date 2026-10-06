FROM --platform=linux/arm64 node:20-alpine AS deps
WORKDIR /app
COPY services/notification-service/package*.json ./
RUN npm ci --omit=dev

FROM --platform=linux/arm64 node:20-alpine AS runtime
WORKDIR /app/services/notification-service
COPY --from=deps /app/node_modules ./node_modules
COPY services/notification-service/src ./src
COPY proto /app/proto
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${HEALTH_PORT:-8080}/readyz || exit 1
CMD ["node", "src/index.js"]
