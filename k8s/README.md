# Deploying to EKS

One EKS cluster runs three isolated environments, each in its own namespace,
with its own databases, secrets and ALB:

| Environment | Namespace | Image tag | Replicas (stateless services) | Pull policy |
|---|---|---|---|---|
| dev | `dev` | `dev` (rolling) | 1 | Always |
| staging | `staging` | `staging` (rolling) | 2 | Always |
| prod | `prod` | pinned release, e.g. `v1` | 2 | IfNotPresent |

## Layout (Kustomize)

```
k8s/
├── cluster/                 Cluster-wide, apply once (shared by all environments)
│   └── storageclass.yaml    gp3 EBS StorageClass "ebs-gp3"
├── base/                    Manifests shared by every environment (no namespace, no secrets)
│   ├── kustomization.yaml   resource list + ECR repositories
│   ├── mongodb-users/  mongodb-products/  rabbitmq/
│   ├── user-service/  product-service/  api-gateway/
│   ├── storefront/  admin/
│   └── ingress.yaml         ALB: /api → gateway, /admin → admin, / → storefront
├── overlays/
│   ├── dev/                 namespace, image tag, replicas, secrets for dev
│   ├── staging/
│   └── prod/
│       ├── kustomization.yaml
│       ├── namespace.yaml
│       └── secrets/*.env    real secret values (git-ignored)
└── secrets.example/*.env    templates for overlays/<env>/secrets/
```

- **Change something for every environment:** edit `base/`.
- **Change one environment:** edit its `overlays/<env>/kustomization.yaml`.
- **Preview** the exact output without touching the cluster:
  `kubectl kustomize k8s/overlays/<env>`.

Not yet included: order-service, notification-service, mongodb-orders.
Until they exist, `/api/orders` returns 503 (checkout doesn't work).

## 1. Cluster prerequisites (one time)

The commands assume a cluster named `ecommerce` in `us-east-1`.

**Cluster.** The three environments run about 34 application pods plus system
pods. Use at least 3 × `t3.large` (35 pods and 8 GiB each). `t3.medium` nodes
fit only 17 pods each.

```bash
eksctl create cluster --name ecommerce --region us-east-1 \
  --nodegroup-name workers --node-type t3.large --nodes 3 --with-oidc
```

**EBS CSI driver.** This provisions the MongoDB and RabbitMQ volumes. Without
it the PVCs stay `Pending`.

```bash
eksctl create iamserviceaccount --cluster ecommerce --region us-east-1 \
  --namespace kube-system --name ebs-csi-controller-sa \
  --role-name AmazonEKS_EBS_CSI_DriverRole --role-only \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy --approve

eksctl create addon --cluster ecommerce --region us-east-1 --name aws-ebs-csi-driver \
  --service-account-role-arn arn:aws:iam::573802369594:role/AmazonEKS_EBS_CSI_DriverRole --force
```

**AWS Load Balancer Controller.** This turns each environment's Ingress into
an ALB. Without it the Ingresses never get an address.

```bash
curl -fsSLo iam_policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

eksctl create iamserviceaccount --cluster ecommerce --region us-east-1 \
  --namespace kube-system --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::573802369594:policy/AWSLoadBalancerControllerIAMPolicy --approve

helm repo add eks https://aws.github.io/eks-charts && helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName=ecommerce \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

**Shared StorageClass:**

```bash
kubectl apply -f k8s/cluster/
```

## 2. Push images

Images go to ECR as `ecommerce/<service>:<tag>`. The script builds
`linux/amd64` images, because your Mac builds arm64 by default:

```bash
scripts/push-images.sh dev        # for the dev environment
scripts/push-images.sh staging    # for staging
scripts/push-images.sh v1         # a release, for prod
```

## 3. Secrets (per environment)

Each overlay reads its secrets from `overlays/<env>/secrets/*.env`, which git
ignores. To create them for an environment:

```bash
ENV=dev
mkdir -p k8s/overlays/$ENV/secrets
cp k8s/secrets.example/*.env k8s/overlays/$ENV/secrets/
```

Then edit the values:
- Use **different values in every environment.** A leaked dev secret must not
  unlock prod.
- Use letters and digits only for passwords, because they're embedded in
  connection URLs.
- For `JWT_SECRET`, use `openssl rand -hex 32`.

Kustomize adds a hash of the contents to each Secret's name. Changing a value
and re-applying rolls the pods that use it. MongoDB and RabbitMQ read their
passwords only on first start, when the volume is empty; see the
[RUNBOOK](../docs/RUNBOOK.md#rotate-the-mongodb-password) for rotating them.

## 4. Deploy

```bash
kubectl config current-context                 # make sure this is the EKS cluster
kubectl apply -k k8s/overlays/dev
kubectl -n dev get pods,pvc,ingress
```

Repeat for `staging` and `prod`.

On a cold start, user-service and product-service may restart once while
MongoDB starts up. That is expected.

Each environment gets its **own ALB**. The hostname appears in the `ADDRESS`
column after about 2 to 3 minutes:

| Path | Goes to |
|---|---|
| `http://<hostname>/` | Shop |
| `http://<hostname>/admin/` | Admin panel |
| `http://<hostname>/api/` | API |

With a domain, you can switch to host rules (`dev.abc.com`, `staging.abc.com`,
`abc.com`) and share one ALB through `alb.ingress.kubernetes.io/group.name`.

## Releasing

| Environment | How |
|---|---|
| dev / staging | `scripts/push-images.sh dev`, then `kubectl -n dev rollout restart deploy`. Pods re-pull the moving tag. |
| prod | `scripts/push-images.sh v2`, set `newTag: v2` for the images in `overlays/prod/kustomization.yaml`, commit, then `kubectl apply -k k8s/overlays/prod` |

## Cleanup

Delete the Ingress first, so the controller removes the ALB. Deleting the
overlay also deletes the namespace, its PVCs and their EBS volumes
(**data is lost**).

```bash
kubectl -n dev delete ingress --all
kubectl delete -k k8s/overlays/dev
```

`k8s/cluster/` is shared. Delete it only after all three environments are gone.
