# Service catalog

This is the operational reference for each deployable unit. Configuration is
read only from environment variables. No service reads a config file at
runtime: `dotenv` is only for local runs outside Docker.

**Common behaviour (all Node.js services)**
- **Logs** go to stdout/stderr as plain text: `console` output, and `morgan`
  dev format in the gateway. Logs are not structured JSON.
- **SIGTERM / SIGINT** trigger a graceful shutdown. The service stops taking
  new work, finishes what's in flight, closes its connections and exits 0.
  It is force-killed with exit 1 after **10 s**.
- **Startup failures** (e.g. MongoDB unreachable) exit with code **1**, so
  the orchestrator restarts the service. A one-off restart on a cold cluster
  start is expected.
- **RabbitMQ clients** reconnect on their own, with exponential backoff
  capped at 30 s.
- **Base image** is `node:22-alpine` (LTS) for the services, `nginx:stable-alpine`
  for the frontends.

---

## api-gateway

The public REST API. It is stateless and scales horizontally.

| | |
|---|---|
| Port | `3000` HTTP |
| Liveness | `GET /health` → 200 `{"status":"ok"}` (process only) |
| Readiness (diagnostic) | `GET /ready` → 200 when user, product and order services all report SERVING, otherwise 503 with per-dependency status. **Do not use it as the K8s readiness probe**, because it would cascade backend outages. |
| Exposed | Through the ALB at `/api/*`. `/health` and `/ready` are not exposed publicly. |
| Depends on | user-service (hard: every authenticated call), product-service, order-service |
| Image | `dev/api-gateway`, build context: repo root |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `USER_SERVICE_URL` | yes | `localhost:50051` | `host:port`, no scheme |
| `PRODUCT_SERVICE_URL` | yes | `localhost:50052` | |
| `ORDER_SERVICE_URL` | yes | `localhost:50053` | |

## user-service

Handles registration, login, JWT validation and roles.

| | |
|---|---|
| Port | `50051` gRPC |
| Health | `grpc.health.v1`: service `""` is readiness (MongoDB connected), `liveness` is the process |
| Depends on | mongodb-users (hard) |
| Image | `dev/user-service`, build context: repo root |
| Admin tool | `node src/scripts/promoteAdmin.js <email>`, run inside a pod (see [RUNBOOK](RUNBOOK.md#promote-a-user-to-admin)) |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GRPC_PORT` | no | `50051` | |
| `MONGO_URI` | yes | `mongodb://localhost:27017/users` | K8s builds it from `mongodb-users-secret` |
| `JWT_SECRET` | **yes, secret** | ⚠️ `supersecretkey` | **Must be set.** The fallback is publicly known. 32+ random bytes, e.g. `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | no | `7d` | Any [`ms`](https://github.com/vercel/ms) duration |

## product-service

Handles the product catalogue and atomic stock reservation.

| | |
|---|---|
| Port | `50052` gRPC |
| Health | `grpc.health.v1` (same as user-service) |
| Depends on | mongodb-products (hard) |
| Called by | api-gateway, order-service (`ReserveStock`, `ReleaseStock`) |
| Image | `dev/product-service`, build context: repo root |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GRPC_PORT` | no | `50052` | |
| `MONGO_URI` | yes | `mongodb://localhost:27017/products` | |

## order-service

Handles orders and order status, and publishes order events.

| | |
|---|---|
| Port | `50053` gRPC |
| Health | `grpc.health.v1`. Readiness covers MongoDB only. RabbitMQ is a soft dependency: if it's down, order events are lost but orders still work. |
| Depends on | mongodb-orders (hard), product-service (needed to place and cancel orders), RabbitMQ (soft) |
| Image | `dev/order-service`, build context: repo root |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GRPC_PORT` | no | `50053` | |
| `MONGO_URI` | yes | `mongodb://localhost:27017/orders` | |
| `PRODUCT_SERVICE_URL` | yes | `localhost:50052` | |
| `RABBITMQ_URL` | yes | `amqp://localhost` | `amqp://user:pass@rabbitmq:5672` |

## storefront

The customer React app, served by nginx. It is stateless.

| | |
|---|---|
| Port | `80` HTTP |
| Health | `GET /healthz` → 200 |
| Routing | SPA: unknown paths serve `index.html`. `/assets/*` is cached for 1 year (hashed filenames). |
| Image | `dev/storefront`, build context: `frontends/storefront` |

| Variable | Required | Default | Notes |
|---|---|---|---|
| `API_GATEWAY_URL` | local only | `http://api-gateway:3000` | Used by nginx to forward `/api` in docker-compose. Not used on EKS, where the ALB routes `/api` to the gateway. |

## admin

The admin React app, served by nginx **under `/admin/`**. It is stateless.

| | |
|---|---|
| Port | `80` HTTP |
| Health | `GET /healthz` → 200 |
| Routing | App at `/admin/`. `/` redirects to `/admin/`. API calls go to `/api`. |
| Image | `dev/admin`, build context: `frontends/admin` |

Configuration: same as storefront.

## MongoDB (×3: users, products, orders)

| | |
|---|---|
| Image | `mongo:6.0`; MongoDB 5+ needs a CPU with AVX, which all current EC2 instance types have |
| K8s | StatefulSet with 1 replica, headless Service, 1Gi gp3 PVC, root auth from `mongodb-<name>-secret` |
| Health | `mongosh --eval "db.adminCommand('ping')"` |
| Backups | **None configured.** See [RUNBOOK](RUNBOOK.md#back-up-and-restore-mongodb) |

## RabbitMQ

| | |
|---|---|
| Image | `rabbitmq:3.13-management-alpine` |
| Ports | `5672` AMQP, `15672` management UI (internal only) |
| K8s | StatefulSet with 1 replica, ClusterIP + headless Services, 1Gi gp3 PVC, default user from `rabbitmq-secret` |
| Health | Readiness `rabbitmq-diagnostics check_port_connectivity`, liveness `ping` |
| Memory | Publishers are blocked at 40% of the container memory limit (1Gi) |

---

## Building images

| Image | Dockerfile | Context |
|---|---|---|
| api-gateway, user-service, product-service, order-service | `services/<name>/Dockerfile` | **repo root** (copies `proto/`) |
| storefront, admin | `frontends/<name>/Dockerfile` | `frontends/<name>` |

- **EKS nodes are amd64; developer Macs are arm64.** CI builds with
  `--platform linux/amd64` and is the only thing that pushes to ECR.
- **Tags are the git commit SHA**, and ECR tags are immutable: a tag always
  means the same image. The manifests use `imagePullPolicy: IfNotPresent`.

## Resource baseline (from shoplite-gitops)

| Workload | Replicas | CPU request | Memory request / limit |
|---|---|---|---|
| api-gateway, user-service, product-service, order-service | 2 each | 50m | 96Mi / 256Mi |
| storefront, admin | 2 each | 10m | 16Mi / 64Mi |
| MongoDB (×3, each) | 1 | 100m | 256Mi / 1Gi |
| RabbitMQ | 1 | 100m | 256Mi / 1Gi |

These are starting values, not measured under load. Tune them after
load testing.
