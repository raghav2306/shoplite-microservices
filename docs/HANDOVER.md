# Handover: development → DevOps

| | |
|---|---|
| Project | ShopLite e-commerce microservices |
| Handover date | 2026-10-06 |
| Code baseline | `main` branch, see git log for the exact commit |
| Development contact | _name / email / Slack_ |
| DevOps owner | _to be assigned_ |

This document covers what is delivered, what is still missing, and what the
DevOps team needs to decide before production. Read it before the other docs.

## Delivered

| Area | State |
|---|---|
| Application | Feature complete: signup and login, product catalogue, cart, checkout, order history and cancellation, admin product management, admin order fulfilment, email notifications |
| Containers | Dockerfiles for all 7 deployables; each has a `HEALTHCHECK` |
| Local environment | `docker-compose.yml` runs the full stack (12 containers, health-gated startup). Verified end to end. |
| Health checks | gRPC `grpc.health.v1` (readiness and liveness) on the gRPC services; HTTP health endpoints on the rest ([SERVICES.md](SERVICES.md)) |
| Resilience | Graceful SIGTERM shutdown, exit code 1 on startup failure, RabbitMQ auto-reconnect, dead-letter queue for failed notifications |
| Kubernetes | Kustomize base plus `dev`, `staging` and `prod` overlays (one namespace each, in one cluster), with mongodb-users, mongodb-products, rabbitmq, user-service, product-service, api-gateway, storefront, admin and an ALB Ingress per environment |
| Tooling | `scripts/push-images.sh` (amd64 build and ECR push), `scripts/smoke-test.sh` (post-deploy checks) |

**Tested so far:**
- The whole application on docker-compose: functional flows, oversell
  prevention under concurrent orders, dead-letter handling, RabbitMQ
  reconnect, MongoDB outage and recovery.
- The core Kubernetes workloads on minikube.

**Not yet tested on EKS.** The ALB Ingress and gp3 StorageClass have never
been applied to a real cluster.

## Outstanding work

| # | Item | Notes |
|---|---|---|
| 1 | **K8s manifests: order-service, notification-service, mongodb-orders** | Until these exist, `/api/orders` returns 503, so checkout doesn't work on EKS. Follow the user-service and mongodb-users patterns. Service details are in [SERVICES.md](SERVICES.md). |
| 2 | **Remove `--platform=linux/arm64`** from the order-service and notification-service Dockerfiles | Otherwise they fail on amd64 nodes with `exec format error`. Then add both to `scripts/push-images.sh`. |
| 3 | **CI/CD pipeline** | None exists. Suggested: build and push on merge to `main`, tagged with the git SHA; deploy; run `smoke-test.sh`. |
| 4 | **TLS** | The Ingress serves HTTP only. Add an ACM certificate (`alb.ingress.kubernetes.io/certificate-arn`) and an HTTP→HTTPS redirect. |
| 5 | **DNS** | Route 53 alias record from the domain to the ALB. |
| 6 | **Production SMTP** | For example Amazon SES, with a verified sender domain. Credentials go into the notification-service secret. |
| 7 | **Backups** | No MongoDB backups. Suggested: AWS Backup or EBS snapshots of the `data-mongodb-*` PVCs. Manual procedure is in the [RUNBOOK](RUNBOOK.md#back-up-and-restore-mongodb). |
| 8 | **Observability** | Logs are plain text on stdout; there are no metrics or tracing. Suggested: Container Insights or Fluent Bit for logs, Prometheus/Grafana or CloudWatch for metrics, and alerts on pod restarts, 5xx rate, DLQ depth and PVC usage. |

## Decisions needed from DevOps

| Decision | Current state / developer recommendation |
|---|---|
| Secrets management | Git-ignored `k8s/overlays/<env>/secrets/*.env` files on the deployer's machine. Recommend AWS Secrets Manager with the External Secrets Operator (one secret path per environment). |
| Managed data stores | MongoDB and RabbitMQ run in-cluster as single replicas. For production, consider MongoDB Atlas or DocumentDB (check compatibility) and Amazon MQ for RabbitMQ. |
| Image tagging policy | dev/staging use moving tags, prod uses `v1`. Recommend git-SHA tags promoted dev → staging → prod. ECR tag immutability then needs separate repositories for the moving tags. |
| Cluster per environment | All three environments share one cluster (namespaces `dev`, `staging`, `prod`), hard-coded to account `573802369594` / `us-east-1`. Recommend a separate prod cluster (or at least a separate node group plus ResourceQuotas) before real traffic. |
| Autoscaling | None. HPA needs metrics-server; the CPU requests in the manifests are a starting point. |
| Network policies | None, so pods in `dev` can reach `prod` services. Recommend default-deny per namespace, then allow only the documented traffic paths ([ARCHITECTURE.md](ARCHITECTURE.md)). |

## Risks

| Risk | Impact | Recommendation |
|---|---|---|
| **Node.js 20 is end-of-life (April 2026)** | No security patches for the runtime in any backend image | Upgrade the service images to `node:22-alpine` (LTS) and re-test |
| **`JWT_SECRET` falls back to a public default** (`supersecretkey`) if unset | Anyone could create admin tokens | Always set it; it's provided by `k8s/overlays/<env>/secrets/user-service.env`, with a different value per environment. Development is asked to change the service to refuse to start without it. |
| Old JWT secret is in git history | Same as above, for any environment that ever used it | Never use `supersecretkey` anywhere; rotate it if it was ever deployed |
| No rate limiting on `/api` (login and register are internet-facing) | Brute-force and abuse | AWS WAF on the ALB (rate-based rules), or limits in the gateway |
| Containers run as root (no `securityContext`) | Bigger blast radius if a container is compromised | Reintroduce `runAsNonRoot` and read-only root filesystems once validated; this was removed deliberately for now |
| dev, staging and prod share one cluster and one node group | A dev load test or a bad dev deploy can starve prod of CPU/memory; one cluster upgrade affects all environments | Separate prod cluster, or ResourceQuotas/LimitRanges per namespace and a dedicated prod node group |
| Single-replica MongoDB and RabbitMQ | A node failure means downtime until the pod is rescheduled. EBS volumes are tied to one AZ, so the pod can only reschedule within that AZ. | Managed services, or replica sets (see decisions) |
| No PodDisruptionBudgets, no `preStop` delay | Node drains can evict all replicas of a service at once; a few 502s during rollouts | Add PDBs (`minAvailable: 1`) and a short `preStop` sleep before production traffic |
| gRPC connections are long-lived | Extra replicas of user-service and product-service get little traffic | Headless Services with client-side `round_robin`, or a service mesh |
| Order events are published without an outbox | A RabbitMQ outage at publish time means a missed email (orders and stock stay correct) | Acceptable for now; implement a transactional outbox if emails become critical |
| No automated tests | Regressions are only caught by the smoke test | Development to add unit and integration tests to CI |

## Production readiness checklist

- [ ] Outstanding items 1–2 done; full stack running on EKS in dev and staging
- [ ] `scripts/smoke-test.sh` passes against each environment, including orders
- [ ] Unique secrets per environment (dev, staging and prod never share a value)
- [ ] TLS and DNS configured
- [ ] Secrets in a secret manager; no `secrets/*.env` files on laptops
- [ ] Strong unique `JWT_SECRET` and MongoDB/RabbitMQ passwords per environment
- [ ] Backups enabled and a restore tested
- [ ] Logs centralised; alerts for restarts, 5xx, DLQ depth, disk usage
- [ ] Node.js upgraded to 22 LTS
- [ ] Rate limiting / WAF on the ALB
- [ ] CI/CD pipeline with immutable image tags
- [ ] Load test done; resource requests and limits and replica counts tuned
- [ ] PDBs and `preStop` delay re-added
- [ ] First admin user promoted ([RUNBOOK](RUNBOOK.md#promote-a-user-to-admin))
