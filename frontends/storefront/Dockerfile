FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine AS runtime
# The nginx image renders templates with envsubst at startup
# nginx's resolver doesn't use DNS search domains, so in Kubernetes set a
# fully qualified name, e.g. http://api-gateway.<namespace>.svc.cluster.local:3000
ENV API_GATEWAY_URL=http://api-gateway:3000
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
