# ShopLite — E-commerce Microservices

ShopLite is an e-commerce platform built from microservices. It has a
customer storefront, an admin panel, and five backend services. The services
talk to each other over gRPC and RabbitMQ, and each owns its own MongoDB
database.

| | |
|---|---|
| **Repository** | https://github.com/raghav2306/ecommerce-microservices |
| **Status** | Application complete; Kubernetes manifests partially complete (see [Handover](docs/HANDOVER.md)) |
| **Runtime** | Node.js (services), React + Vite on nginx (frontends), MongoDB 6, RabbitMQ 3.13 |
| **Target platform** | AWS EKS (us-east-1): environments `dev`, `staging`, `prod` as namespaces; images in ECR (`ecommerce/<service>`) |

## Documentation

| Document | Audience | Contents |
|---|---|---|
| [docs/HANDOVER.md](docs/HANDOVER.md) | **Start here** | What is delivered, what is outstanding, decisions needed, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Everyone | Components, traffic flow, data ownership, events |
| [docs/SERVICES.md](docs/SERVICES.md) | DevOps | Per-service catalog: ports, health checks, configuration, dependencies, scaling |
| [docs/API.md](docs/API.md) | DevOps, QA | Public HTTP API, for smoke tests and monitoring |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | On-call | Deploy, verify, roll back, troubleshoot, routine operations |
| [docs/EKS-DEPLOYMENT.md](docs/EKS-DEPLOYMENT.md) | DevOps | **Step-by-step EKS deployment** of dev, staging and prod: cluster, add-ons, images, secrets, deploy, verify, release, teardown |
| [k8s/README.md](k8s/README.md) | DevOps | Kustomize layout and quick deploy commands |

## Components

| Component | Type | Port | Purpose |
|---|---|---|---|
| storefront | React SPA on nginx | 80 | Customer shop: browse, cart, checkout, orders |
| admin | React SPA on nginx | 80 | Admin panel: products, order fulfilment (served under `/admin/`) |
| api-gateway | Node.js / Express | 3000 | Public REST API (`/api/*`), auth, routes calls to gRPC services |
| user-service | Node.js / gRPC | 50051 | Users, passwords, JWTs, roles |
| product-service | Node.js / gRPC | 50052 | Product catalogue and stock reservation |
| order-service | Node.js / gRPC | 50053 | Orders and order status; publishes order events |
| notification-service | Node.js / RabbitMQ consumer | 8080 (health) | Sends order emails |
| MongoDB × 3 | Database | 27017 | One per service: users, products, orders |
| RabbitMQ | Message broker | 5672 / 15672 | Order events (`order_events` topic exchange) |

## Quick start (local)

The only requirement is Docker Desktop. This starts all 12 containers, each
with a health check, in dependency order:

```bash
docker compose up -d --build
```

| URL | What |
|---|---|
| http://localhost:8080 | Storefront |
| http://localhost:8081/admin/ | Admin panel |
| http://localhost:3000/api | API gateway |
| http://localhost:8025 | Mailpit (catches outgoing email) |
| http://localhost:15672 | RabbitMQ management (guest / guest) |

Admin accounts can't be created through the UI. To make one, register
normally, then promote the user:

```bash
docker compose exec user-service node src/scripts/promoteAdmin.js you@example.com
```

Verify the stack:

```bash
scripts/smoke-test.sh http://localhost:8080 http://localhost:8081/admin/
```

## Repository layout

```
├── services/              Backend services (one folder each; built with repo root as context)
│   ├── api-gateway/
│   ├── user-service/
│   ├── product-service/
│   ├── order-service/
│   └── notification-service/
├── frontends/             React apps (each folder is its own build context)
│   ├── storefront/
│   └── admin/
├── proto/                 gRPC contracts shared by all services
├── k8s/                   Kubernetes: base/ + overlays/{dev,staging,prod} (Kustomize), cluster/
├── scripts/               push-images.sh (ECR), smoke-test.sh
├── docs/                  Handover documentation
└── docker-compose.yml     Full local stack
```

## Building images

The backend services copy the shared `proto/` folder, so they **must be built
from the repository root**:

```bash
docker build -f services/user-service/Dockerfile -t user-service .
docker build -t storefront frontends/storefront
```

For EKS, `scripts/push-images.sh <tag>` builds `linux/amd64` images and pushes
them to ECR (`dev`, `staging`, or a release tag such as `v2` for prod). See [docs/SERVICES.md](docs/SERVICES.md#building-images).
