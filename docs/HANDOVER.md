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
| Application | Feature complete: signup and login, product catalogue, cart, checkout, order history and cancellation, admin product management, admin order fulfilment. Order events are published to RabbitMQ (no consumer yet) |
| Containers | Dockerfiles for all 6 deployables; each has a `HEALTHCHECK` |
| Local environment | `docker-compose.yml` runs the full stack (10 containers, health-gated startup). Verified end to end. |
| Health checks | gRPC `grpc.health.v1` (readiness and liveness) on the gRPC services; HTTP health endpoints on the rest ([SERVICES.md](SERVICES.md)) |
| Resilience | Graceful SIGTERM shutdown, exit code 1 on startup failure, RabbitMQ auto-reconnect |
| Kubernetes | Kustomize manifests (base + `eks` overlay) in the separate [shoplite-gitops](https://github.com/raghav2306/shoplite-gitops) repo, synced by Argo CD. Covers all 6 deployables, MongoDB ×3, RabbitMQ, the StorageClass and the Ingress |
| Infrastructure | Terraform in [shoplite-infra](https://github.com/raghav2306/shoplite-infra): VPC, EKS, EBS CSI, Load Balancer Controller, ECR, GitHub OIDC role for CI, Argo CD |
| CI/CD | `.github/workflows/ci-cd.yml`: verify, compose smoke test, amd64 image build, Trivy scan, push to ECR (SHA tags), bump tags in shoplite-gitops. Argo CD deploys |
| Tooling | `scripts/smoke-test.sh` (post-deploy checks; CI runs it on docker compose) |

**Tested so far:**
- The whole application on docker-compose: functional flows, oversell
  prevention under concurrent orders, RabbitMQ reconnect, MongoDB outage and recovery.

**Not yet tested on EKS.** The ALB Ingress and gp3 StorageClass have never
been applied to a real cluster.

## Outstanding work

| # | Item | Notes |
|---|---|---|
| 1 | ~~K8s manifests: order-service, mongodb-orders~~ | **Done** in shoplite-gitops. |
| 2 | ~~Remove `--platform=linux/arm64` from the order-service Dockerfile~~ | **Done.** All 6 images are built for amd64 by CI. |
| 3 | ~~CI/CD pipeline~~ | **Done.** GitHub Actions + Argo CD (see the [README](../README.md#cicd)). Still to add: run `smoke-test.sh` against EKS after Argo CD finishes a sync. |
| 4 | **TLS** | The Ingress serves HTTP only. Add an ACM certificate (`alb.ingress.kubernetes.io/certificate-arn`) and an HTTP→HTTPS redirect. |
| 5 | **DNS** | Route 53 alias record from the domain to the ALB. |
| 6 | **Backups** | No MongoDB backups. Suggested: AWS Backup or EBS snapshots of the `data-mongodb-*` PVCs. Manual procedure is in the [RUNBOOK](RUNBOOK.md#back-up-and-restore-mongodb). |
| 7 | **Observability** | Logs are plain text on stdout; there are no metrics or tracing. Suggested: Container Insights or Fluent Bit for logs, Prometheus/Grafana or CloudWatch for metrics, and alerts on pod restarts, 5xx rate and PVC usage. |

## Decisions needed from DevOps

| Decision | Current state / developer recommendation |
|---|---|
| Secrets management | Git-ignored `secret.yaml` files applied by hand. Recommend AWS Secrets Manager with the External Secrets Operator. |
| Managed data stores | MongoDB and RabbitMQ run in-cluster as single replicas. For production, consider MongoDB Atlas or DocumentDB (check compatibility) and Amazon MQ for RabbitMQ. |
| Image tagging policy | **Done:** git SHA tags, ECR tag immutability on. |
| Environments | One Kustomize overlay, `eks`; CI sets the registry from the account it pushes to. Staging/production would be more overlays plus one Argo CD Application each. |
| Autoscaling | None. HPA needs metrics-server; the CPU requests in the manifests are a starting point. |
| Network policies | None. Recommend default-deny in `ecommerce`, then allow only the documented traffic paths ([ARCHITECTURE.md](ARCHITECTURE.md)). |

## Risks

| Risk | Impact | Recommendation |
|---|---|---|
| ~~Node.js 20 is end-of-life~~ | Resolved | Service images now use `node:22-alpine` (LTS). Re-test on compose and EKS. |
| **`JWT_SECRET` falls back to a public default** (`supersecretkey`) if unset | Anyone could create admin tokens | Always set it; it's provided by `shoplite-gitops/base/user-service/secret.yaml`. Development is asked to change the service to refuse to start without it. |
| Old JWT secret is in git history | Same as above, for any environment that ever used it | Never use `supersecretkey` anywhere; rotate it if it was ever deployed |
| No rate limiting on `/api` (login and register are internet-facing) | Brute-force and abuse | AWS WAF on the ALB (rate-based rules), or limits in the gateway |
| Containers run as root (no `securityContext`) | Bigger blast radius if a container is compromised | Reintroduce `runAsNonRoot` and read-only root filesystems once validated; this was removed deliberately for now |
| Single-replica MongoDB and RabbitMQ | A node failure means downtime until the pod is rescheduled. EBS volumes are tied to one AZ, so the pod can only reschedule within that AZ. | Managed services, or replica sets (see decisions) |
| No PodDisruptionBudgets, no `preStop` delay | Node drains can evict all replicas of a service at once; a few 502s during rollouts | Add PDBs (`minAvailable: 1`) and a short `preStop` sleep before production traffic |
| gRPC connections are long-lived | Extra replicas of user-service and product-service get little traffic | Headless Services with client-side `round_robin`, or a service mesh |
| Order events are published without an outbox | A RabbitMQ outage at publish time drops that event (orders and stock stay correct) | Acceptable while nothing consumes events; add a transactional outbox before relying on them |
| No unit or integration tests | Regressions are only caught by the smoke test, which CI runs on docker compose | Development to add tests; CI already runs `npm test` in each package as soon as one defines it |

## Production readiness checklist

- [x] Outstanding item 1 done (manifests for every service)
- [ ] Full stack running on EKS
- [ ] `scripts/smoke-test.sh https://<domain>` passes, including orders
- [ ] TLS and DNS configured
- [ ] Secrets in a secret manager; no `secret.yaml` on laptops
- [ ] Strong unique `JWT_SECRET` and MongoDB/RabbitMQ passwords per environment
- [ ] Backups enabled and a restore tested
- [ ] Logs centralised; alerts for restarts, 5xx, disk usage
- [x] Node.js upgraded to 22 LTS
- [ ] Rate limiting / WAF on the ALB
- [x] CI/CD pipeline with immutable image tags
- [ ] Load test done; resource requests and limits and replica counts tuned
- [ ] PDBs and `preStop` delay re-added
- [ ] First admin user promoted ([RUNBOOK](RUNBOOK.md#promote-a-user-to-admin))
