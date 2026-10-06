FROM node:20-alpine AS deps
WORKDIR /app
COPY services/user-service/package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app/services/user-service
COPY --from=deps /app/node_modules ./node_modules
COPY services/user-service/src ./src
COPY proto /app/proto
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "src/healthcheck.js"]
CMD ["node", "src/index.js"]
