# ShopLite — E-commerce Microservices

ShopLite is an e-commerce platform built from microservices. It has a
customer storefront, an admin panel, and four backend services. The services
talk to each other over gRPC, each owns its own MongoDB database, and
order-service publishes order events to RabbitMQ.

| | |
|---|---|
| **Repository** | https://github.com/raghav2306/shoplite-microservices |
| **Status** | Application complete; CI/CD with GitHub Actions + Argo CD. Open items in [Handover](docs/HANDOVER.md) |
| **Runtime** | Node.js (services), React + Vite on nginx (frontends), MongoDB 6, RabbitMQ 3.13 |
| **Target platform** | AWS EKS (us-east-1), images in ECR |
| **Related repos** | [shoplite-infra](https://github.com/raghav2306/shoplite-infra) (Terraform: EKS, ECR, Argo CD) · [shoplite-gitops](https://github.com/raghav2306/shoplite-gitops) (Kubernetes manifests, synced by Argo CD) |

## Documentation

| Document | Audience | Contents |
|---|---|---|
| [docs/HANDOVER.md](docs/HANDOVER.md) | **Start here** | What is delivered, what is outstanding, decisions needed, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Everyone | Components, traffic flow, data ownership, events |
| [docs/SERVICES.md](docs/SERVICES.md) | DevOps | Per-service catalog: ports, health checks, configuration, dependencies, scaling |
| [docs/API.md](docs/API.md) | DevOps, QA | Public HTTP API, for smoke tests and monitoring |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | On-call | Deploy, verify, roll back, troubleshoot, routine operations |
| [shoplite-gitops](https://github.com/raghav2306/shoplite-gitops) | DevOps | Kubernetes manifests and Argo CD Applications (separate repo, the source of truth for the clusters) |

## Components

| Component | Type | Port | Purpose |
|---|---|---|---|
| storefront | React SPA on nginx | 80 | Customer shop: browse, cart, checkout, orders |
| admin | React SPA on nginx | 80 | Admin panel: products, order fulfilment (served under `/admin/`) |
| api-gateway | Node.js / Express | 3000 | Public REST API (`/api/*`), auth, routes calls to gRPC services |
| user-service | Node.js / gRPC | 50051 | Users, passwords, JWTs, roles |
| product-service | Node.js / gRPC | 50052 | Product catalogue and stock reservation |
| order-service | Node.js / gRPC | 50053 | Orders and order status; publishes order events |
| MongoDB × 3 | Database | 27017 | One per service: users, products, orders |
| RabbitMQ | Message broker | 5672 / 15672 | Order events (`order_events` topic exchange; no consumer yet) |

## Quick start (local)

The only requirement is Docker Desktop. This starts all 10 containers, each
with a health check, in dependency order:

```bash
docker compose up -d --build
```

| URL | What |
|---|---|
| http://localhost:8080 | Storefront |
| http://localhost:8081/admin/ | Admin panel |
| http://localhost:3000/api | API gateway |
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
│   └── order-service/
├── frontends/             React apps (each folder is its own build context)
│   ├── storefront/
│   └── admin/
├── proto/                 gRPC contracts shared by all services
├── scripts/               smoke-test.sh
├── .github/workflows/     ci-cd.yml: test, build, scan, push to ECR, bump tags in shoplite-gitops
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

Images for EKS are built and pushed by CI (below), never by hand. See
[docs/SERVICES.md](docs/SERVICES.md#building-images).

## CI/CD

[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) runs on every pull
request and every push to `main`:

| Job | Pull request | Push to `main` |
|---|---|---|
| **verify**: `npm ci`, syntax check (services), `vite build` (frontends), `npm test` if present | ✓ | ✓ |
| **smoke**: `docker compose up --wait` + `scripts/smoke-test.sh` | ✓ | ✓ |
| **images**: build 6 `linux/amd64` images, Trivy scan (fails on fixable CRITICAL) | ✓ | ✓ |
| ↳ push to ECR as `dev/<name>:<commit-sha>` | | ✓ |
| **deploy**: set the new tags in `shoplite-gitops/overlays/eks`, commit, push | | ✓ |

The pipeline never talks to the cluster. Argo CD sees the gitops commit and
rolls it out. To roll back, `git revert` that commit in shoplite-gitops.

**One-time setup** (Settings → Secrets and variables → Actions), after
`shoplite-infra` has been applied:

| Kind | Name | Value |
|---|---|---|
| Variable | `AWS_ROLE_ARN` | `terraform output -raw github_ci_role_arn` in shoplite-infra |
| Variable | `AWS_REGION` | `us-east-1` |
| Variable | `GITOPS_REPO` | `raghav2306/shoplite-gitops` |
| Secret | `GITOPS_TOKEN` | Fine-grained token with **Contents: read and write** on shoplite-gitops only |

AWS access uses GitHub OIDC; no AWS keys are stored in GitHub. Only runs on
`main` can assume the role, so pull requests build and scan but can't push.
