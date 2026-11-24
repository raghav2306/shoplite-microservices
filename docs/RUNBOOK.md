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

1. Create the platform with [shoplite-infra](https://github.com/raghav2306/shoplite-infra)
   (`scripts/apply.sh`): VPC, EKS, add-ons, ECR, the CI role and Argo CD. It also
   creates the app's Secrets from your shoplite-gitops clone.
2. Set up CI in this repo ([README → CI/CD](../README.md#cicd)) and push to `main`.
   CI pushes the images and bumps the tags in shoplite-gitops; Argo CD deploys them.
3. [Verify](#verify-a-deployment), then [promote the first admin](#promote-a-user-to-admin).

Tear down with `scripts/destroy.sh` in shoplite-infra.

## Release a new version

Merge to `main`. CI builds, scans and pushes every image tagged with the
commit SHA, then commits the new tags to `shoplite-gitops/overlays/eks`.
Argo CD syncs that commit within ~3 minutes (press REFRESH in the UI to skip
the wait). Watch it:

```bash
kubectl -n argocd get application shoplite-eks          # Synced / Healthy
k rollout status deploy/<service> --timeout=180s
```

ECR tags are immutable, so a tag always means the same image.

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

Roll back in Git, not with `kubectl rollout undo`: Argo CD's self-heal would
put the bad version straight back. In shoplite-gitops:

```bash
git log --oneline -- overlays/eks/kustomization.yaml   # find the "deploy: ..." commit
git revert <sha> && git push                           # Argo CD rolls back to the previous tags
```

The previous images are still in ECR: the newest 20 per service are kept.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ImagePullBackOff` | Tag not in ECR (the CI `images` job failed or was skipped), or the tag points to another account's registry | `aws ecr describe-images --repository-name dev/<service>`; check the CI run for that commit |
| `CrashLoopBackOff`, log says `exec format error` | arm64 image on amd64 nodes, e.g. built on a Mac and pushed by hand | Let CI build it: it always builds `linux/amd64` |
| `CreateContainerConfigError` | Secret missing | `k get secrets`; create it from `shoplite-gitops/base/<name>/secret.yaml.example`, then `kubectl apply -f` it |
| PVC `Pending`, Mongo or RabbitMQ pod `Pending` | EBS CSI driver add-on missing, or its IAM role missing | `k describe pvc <name>`; `terraform apply` in shoplite-infra installs the add-on and its role |
| App pods `Pending`, `Too many pods` | Node pod limit reached (t3.small allows 11) | Use t3.medium or larger, or add nodes |
| user- or product-service restarts once at cold start | MongoDB not ready yet; the service exits 1 by design | None, if it stabilises. If it keeps restarting, check Mongo |
| Service logs `Authentication failed` against Mongo | Password in `secret.yaml` changed after the volume was first created | Mongo keeps its original password. Change it with [Rotate MongoDB password](#rotate-the-mongodb-password), or delete the PVC (**deletes data**) |
| Ingress has no `ADDRESS` | AWS Load Balancer Controller missing or failing | `kubectl -n kube-system logs deploy/aws-load-balancer-controller` |
| Every `/api` call returns 502 or 503 from the ALB | api-gateway targets unhealthy | EC2 → Target groups → health. The gateway health check must be `/health` (patch in `shoplite-gitops/overlays/eks/kustomization.yaml`) |
| `/api/orders` returns 503, everything else works | order-service down or not ready | `k get pods -l app=order-service`; `k logs deploy/order-service`. Its readiness depends on mongodb-orders |
| Login works, then every call returns 401 | `JWT_SECRET` changed (tokens invalidated) | Users must log in again. Expected after a secret rotation |
| Admin panel says "doesn't have admin access" | User not promoted, or old token | [Promote](#promote-a-user-to-admin), then log out and back in |
| order-service logs `Failed to publish` | RabbitMQ unreachable | Orders still work (RabbitMQ is a soft dependency); check `k get pods -l app=rabbitmq` |

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
# set a new JWT_SECRET in ../shoplite-gitops/base/user-service/secret.yaml (openssl rand -hex 32)
kubectl apply -f ../shoplite-gitops/base/user-service/secret.yaml
k rollout restart deploy/user-service
```

### Rotate the MongoDB password

The root password is set only when the volume is first created, so changing
the Secret alone does nothing. Change it inside MongoDB first:

```bash
k exec -it mongodb-users-0 -- mongosh -u root -p '<old>' --authenticationDatabase admin \
  --eval "db.getSiblingDB('admin').changeUserPassword('root', '<new>')"
# update MONGO_INITDB_ROOT_PASSWORD in ../shoplite-gitops/base/mongodb-users/secret.yaml
kubectl apply -f ../shoplite-gitops/base/mongodb-users/secret.yaml
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

### Scale

```bash
k scale deploy/api-gateway --replicas=4
```

- **Scalable:** api-gateway, user-service, product-service, order-service,
  storefront, admin. All are stateless.
- **Not scalable by changing replicas:** MongoDB and RabbitMQ. They run as
  single-node StatefulSets; scaling them needs replica-set or cluster
  configuration.
- **gRPC caveat:** each client keeps one long-lived HTTP/2 connection per
  Service, so extra user-service or product-service replicas receive little
  traffic. See [HANDOVER.md](HANDOVER.md#risks).
