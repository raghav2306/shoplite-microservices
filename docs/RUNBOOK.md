# Runbook

There are three environments, each in its own namespace: `dev`, `staging`
and `prod`. Before running anything, confirm which cluster you're pointed at,
then set the environment:

```bash
kubectl config current-context
ENV=prod                     # dev | staging | prod
alias k="kubectl -n $ENV"
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

Follow [EKS-DEPLOYMENT.md](EKS-DEPLOYMENT.md). It covers the cluster, the
EBS CSI driver, the AWS Load Balancer Controller, images, per-environment
secrets, `kubectl apply -k k8s/overlays/<env>`, verification and teardown.

## Release a new version

**dev and staging** use moving tags (`dev`, `staging`) with
`imagePullPolicy: Always`, so pushing and restarting is enough:

```bash
scripts/push-images.sh staging
kubectl -n staging rollout restart deploy
kubectl -n staging rollout status deploy/api-gateway --timeout=180s
```

**prod** uses a pinned tag with `IfNotPresent`, so every release needs a
**new** tag:

```bash
scripts/push-images.sh v2
# set newTag: v2 for the images in k8s/overlays/prod/kustomization.yaml, commit, then:
kubectl kustomize k8s/overlays/prod | less      # review
kubectl apply -k k8s/overlays/prod
kubectl -n prod rollout status deploy/api-gateway --timeout=180s
```

Promote the same build through the environments (dev → staging → prod).
Don't rebuild between staging and prod.

Rollouts use `maxUnavailable: 0`. A new pod has to pass its readiness probe
before an old one is removed, so a bad build stalls the rollout instead of
taking the service down.

**Proto changes:** if `proto/*.proto` changed, roll out the **servers** (the
gRPC services) before the **clients** (api-gateway, order-service). Only add
fields; never renumber or remove existing ones.

## Verify a deployment

```bash
k get pods,pvc,ingress                      # all pods Running and READY, PVCs Bound, Ingress has an ADDRESS
scripts/smoke-test.sh http://<alb-hostname>  # that environment's ALB; exits non-zero on failure
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

For prod, also revert `newTag` in `k8s/overlays/prod/kustomization.yaml`, so
the next `kubectl apply -k` doesn't reintroduce the bad version.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ImagePullBackOff` | Image or tag not in ECR, or node role lacks ECR read | `aws ecr describe-images --repository-name ecommerce/<service>`; re-run `push-images.sh <tag>` |
| `CrashLoopBackOff`, log says `exec format error` | arm64 image on amd64 nodes | Rebuild with `scripts/push-images.sh` (forces `linux/amd64`) |
| `kubectl apply -k` fails: `secrets/<name>.env: no such file` | Secrets not created for this environment | Copy `k8s/secrets.example/*.env` to `k8s/overlays/<env>/secrets/` and set values |
| PVC `Pending`, Mongo or RabbitMQ pod `Pending` | EBS CSI driver add-on missing, or its IAM role missing | `k describe pvc <name>`; install the add-on ([EKS-DEPLOYMENT step 3](EKS-DEPLOYMENT.md#3-install-the-ebs-csi-driver-and-storageclass)) |
| App pods `Pending`, `Too many pods` or `Insufficient memory` | Node capacity: all 3 environments share the cluster (~34 app pods) | Add nodes, or use larger instances (3 × t3.large minimum) |
| user- or product-service restarts once at cold start | MongoDB not ready yet; the service exits 1 by design | None, if it stabilises. If it keeps restarting, check Mongo |
| Service logs `Authentication failed` against Mongo | Password in `secrets/*.env` changed after the volume was first created | Mongo keeps its original password. Change it with [Rotate MongoDB password](#rotate-the-mongodb-password), or delete the PVC (**deletes data**) |
| Ingress has no `ADDRESS` | AWS Load Balancer Controller missing or failing | `kubectl -n kube-system logs deploy/aws-load-balancer-controller` |
| Every `/api` call returns 502 or 503 from the ALB | api-gateway targets unhealthy | EC2 → Target groups → health. The gateway health check must be `/health` (annotation on `k8s/base/api-gateway/service.yaml`) |
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
# set a new JWT_SECRET in k8s/overlays/$ENV/secrets/user-service.env (openssl rand -hex 32)
kubectl apply -k k8s/overlays/$ENV       # new Secret name (content hash), so user-service rolls automatically
```

### Rotate the MongoDB password

The root password is set only when the volume is first created, so changing
the Secret alone does nothing. Change it inside MongoDB first:

```bash
k exec -it mongodb-users-0 -- mongosh -u root -p '<old>' --authenticationDatabase admin \
  --eval "db.getSiblingDB('admin').changeUserPassword('root', '<new>')"
# update MONGO_INITDB_ROOT_PASSWORD in k8s/overlays/$ENV/secrets/mongodb-users.env
kubectl apply -k k8s/overlays/$ENV             # user-service rolls and picks up the new MONGO_URI
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
