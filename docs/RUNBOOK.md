# Runbook

All commands assume namespace `ecommerce`. Before running anything, confirm
which cluster you're pointed at:

```bash
kubectl config current-context
alias k='kubectl -n ecommerce'
```

## Contents

- [First-time deployment](#first-time-deployment)
- [Release a new version](#release-a-new-version)
- [Verify a deployment](#verify-a-deployment)
- [Roll back](#roll-back)
- [Troubleshooting](#troubleshooting)
- [Routine operations](#routine-operations)

---

## First-time deployment

Follow [k8s/README.md](../k8s/README.md). It covers cluster prerequisites
(EBS CSI driver, AWS Load Balancer Controller, node size), pushing images,
secrets, and `kubectl apply -R -f k8s/`.

## Release a new version

Use a **new image tag for every release**. The Deployments use
`imagePullPolicy: IfNotPresent`, so pushing again under the same tag does not
roll out new code.

```bash
scripts/push-images.sh v2                       # builds linux/amd64, pushes all images
# then update `image: ...:v2` in k8s/<service>/deployment.yaml, commit, and:
kubectl apply -R -f k8s/
k rollout status deploy/<service> --timeout=180s
```

Rollouts use `maxUnavailable: 0`. A new pod has to pass its readiness probe
before an old one is removed, so a bad build stalls the rollout instead of
taking the service down.

**Proto changes:** if `proto/*.proto` changed, roll out the **servers** (the
gRPC services) before the **clients** (api-gateway, order-service). Only add
fields; never renumber or remove existing ones.

## Verify a deployment

```bash
k get pods,pvc,ingress                      # all pods Running and READY, PVCs Bound, Ingress has an ADDRESS
scripts/smoke-test.sh https://<domain>      # exits non-zero on failure
```

The smoke test checks both frontends, the product API, signup, login, an
authenticated call, and the orders API. It **creates one test user**
(`smoke-<timestamp>@example.com`) on every run.

## Roll back

```bash
k rollout undo deploy/<service>             # back to the previous ReplicaSet
k rollout history deploy/<service>          # list revisions
k rollout undo deploy/<service> --to-revision=<n>
```

Then revert the `image:` tag in git, so the next `kubectl apply` doesn't
reintroduce the bad version.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ImagePullBackOff` | Image or tag not in ECR, or node role lacks ECR read | `aws ecr describe-images --repository-name dev/<service>`; re-run `push-images.sh` |
| `CrashLoopBackOff`, log says `exec format error` | arm64 image on amd64 nodes | Rebuild with `scripts/push-images.sh` (forces `linux/amd64`) |
| `CreateContainerConfigError` | Secret missing | `k get secrets`; create it from `k8s/<name>/secret.yaml.example`, then apply |
| PVC `Pending`, Mongo or RabbitMQ pod `Pending` | EBS CSI driver add-on missing, or its IAM role missing | `k describe pvc <name>`; install the add-on ([k8s/README](../k8s/README.md)) |
| App pods `Pending`, `Too many pods` | Node pod limit reached (t3.small allows 11) | Use t3.medium or larger, or add nodes |
| user- or product-service restarts once at cold start | MongoDB not ready yet; the service exits 1 by design | None, if it stabilises. If it keeps restarting, check Mongo |
| Service logs `Authentication failed` against Mongo | Password in `secret.yaml` changed after the volume was first created | Mongo keeps its original password. Change it with [Rotate MongoDB password](#rotate-the-mongodb-password), or delete the PVC (**deletes data**) |
| Ingress has no `ADDRESS` | AWS Load Balancer Controller missing or failing | `kubectl -n kube-system logs deploy/aws-load-balancer-controller` |
| Every `/api` call returns 502 or 503 from the ALB | api-gateway targets unhealthy | EC2 → Target groups → health. The gateway health check must be `/health` (annotation on `k8s/api-gateway/service.yaml`) |
| `/api/orders` returns 503, everything else works | order-service not deployed or down | Expected until order-service manifests exist |
| Login works, then every call returns 401 | `JWT_SECRET` changed (tokens invalidated) | Users must log in again. Expected after a secret rotation |
| Admin panel says "doesn't have admin access" | User not promoted, or old token | [Promote](#promote-a-user-to-admin), then log out and back in |
| Emails not arriving | SMTP misconfigured, or messages in the DLQ | `k logs deploy/notification-service`; [inspect the DLQ](#inspect-and-replay-the-dead-letter-queue) |
| Order placed but no email | RabbitMQ was down when the order was published (no outbox) | Check order-service logs for `Failed to publish`. Known limitation |

Useful commands:

```bash
k logs deploy/<service> --tail=100 -f
k logs <pod> --previous                       # logs of the crashed container
k describe pod <pod>                          # events: probes, scheduling, image pulls
k get events --sort-by=.lastTimestamp | tail -20
k port-forward svc/api-gateway 3000           # then: curl localhost:3000/ready
```

---

## Routine operations

### Promote a user to admin

The user must have registered already.

```bash
k exec deploy/user-service -- node src/scripts/promoteAdmin.js user@example.com
```

The user must log out and back in to get a token with the admin role.

### Rotate the JWT secret

This logs out **every** user, because all existing tokens become invalid.

```bash
# set a new JWT_SECRET in k8s/user-service/secret.yaml (openssl rand -hex 32)
kubectl apply -f k8s/user-service/secret.yaml
k rollout restart deploy/user-service
```

### Rotate the MongoDB password

The root password is set only when the volume is first created, so changing
the Secret alone does nothing. Change it inside MongoDB first:

```bash
k exec -it mongodb-users-0 -- mongosh -u root -p '<old>' --authenticationDatabase admin \
  --eval "db.getSiblingDB('admin').changeUserPassword('root', '<new>')"
# update MONGO_INITDB_ROOT_PASSWORD in k8s/mongodb-users/secret.yaml
kubectl apply -f k8s/mongodb-users/secret.yaml
k rollout restart deploy/user-service          # picks up the new MONGO_URI
```

Do the same for `mongodb-products` and product-service.

### Back up and restore MongoDB

**No automated backups exist yet.** Recommended: AWS Backup or scheduled EBS
snapshots of the `data-mongodb-*` volumes. For a manual logical backup:

```bash
# backup (no -t: the output is a binary stream)
k exec mongodb-users-0 -- sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" \
  -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
  > users-$(date +%F).archive.gz

# restore (replaces existing collections)
k exec -i mongodb-users-0 -- sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" \
  -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip --drop' \
  < users-YYYY-MM-DD.archive.gz
```

### Inspect and replay the dead-letter queue

Failed notifications land in `notification_service_queue.dlq`. Each message
carries headers `x-retries`, `x-routing-key` and `x-last-error`.

```bash
k port-forward svc/rabbitmq 15672    # http://localhost:15672, credentials in rabbitmq-secret
```

- **Inspect:** Queues → `notification_service_queue.dlq` → Get messages.
- **Replay** after fixing the cause: enable the shovel plugin once with
  `k exec rabbitmq-0 -- rabbitmq-plugins enable rabbitmq_shovel rabbitmq_shovel_management`.
  Then on the DLQ page, use **Move messages** to `notification_service_queue`.
  Replayed messages get one more attempt before returning to the DLQ.

### Scale

```bash
k scale deploy/api-gateway --replicas=4
```

- **Scalable:** api-gateway, user-service, product-service, order-service,
  notification-service (competing consumers), storefront, admin. All are
  stateless.
- **Not scalable by changing replicas:** MongoDB and RabbitMQ. They run as
  single-node StatefulSets; scaling them needs replica-set or cluster
  configuration.
- **gRPC caveat:** each client keeps one long-lived HTTP/2 connection per
  Service, so extra user-service or product-service replicas receive little
  traffic. See [HANDOVER.md](HANDOVER.md#risks).
