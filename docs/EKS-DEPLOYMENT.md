# EKS deployment guide (dev, staging, prod namespaces)

This guide deploys ShopLite to AWS EKS, from an empty AWS account to working
URLs. One cluster runs three isolated environments, **`dev`**, **`staging`**
and **`prod`**, each in its own namespace with its own databases, secrets
and ALB.

It uses Docker, Amazon ECR, Amazon EKS, Kustomize, Deployments, StatefulSets,
PVCs, the EBS CSI driver, ClusterIP Services, the AWS Load Balancer
Controller and an Ingress.

> All commands are bash. On Windows, use **Git Bash** or **WSL**.
> Placeholders look like `<THIS>`; the shell variables set in
> [step 1](#1-set-variables) fill most of them in for you.

---

## What gets deployed

Each namespace (`dev`, `staging`, `prod`) gets a complete copy of this:

```
                       Internet
                          │
                          ▼
           ┌──────────────────────────────┐
           │  ALB (one per environment,   │   Ingress: "frontends"
           │  from the Ingress)           │
           └───┬──────────┬───────────┬───┘
         /api/*│   /admin/*│         /*│
               ▼           ▼           ▼
        ┌───────────┐ ┌─────────┐ ┌────────────┐
        │api-gateway│ │  admin  │ │ storefront │   Deployments
        │  :3000    │ │ nginx:80│ │  nginx:80  │   ClusterIP Services
        └─────┬─────┘ └─────────┘ └────────────┘
              │ gRPC
      ┌───────┴────────┐
      ▼                ▼
┌─────────────┐  ┌───────────────┐
│user-service │  │product-service│               Deployments
│   :50051    │  │    :50052     │               ClusterIP Services
└──────┬──────┘  └───────┬───────┘
       ▼                 ▼
┌─────────────┐  ┌────────────────┐  ┌──────────┐
│mongodb-users│  │mongodb-products│  │ rabbitmq │ StatefulSets (1 replica)
│  headless   │  │   headless     │  │          │ headless Services
└──────┬──────┘  └───────┬────────┘  └────┬─────┘
      PVC               PVC              PVC      gp3 EBS volumes (1Gi)
```

| | dev | staging | prod |
|---|---|---|---|
| Namespace | `dev` | `staging` | `prod` |
| Image tag | `dev` (moving) | `staging` (moving) | `v1` (pinned; new tag per release) |
| Replicas per Deployment | 1 | 2 | 2 |
| `imagePullPolicy` | Always | Always | IfNotPresent |
| Secrets | `k8s/overlays/dev/secrets/` | `…/staging/secrets/` | `…/prod/secrets/` |

Shared by all three: the `ebs-gp3` StorageClass and the add-ons (EBS CSI
driver, AWS Load Balancer Controller).

**Not deployed yet:** order-service, notification-service, mongodb-orders.
Until they exist, signup, login, products, the cart and admin product
management work, but placing or listing orders returns **503**.

### How the manifests are organised (Kustomize)

```
k8s/
├── cluster/storageclass.yaml   shared, applied once per cluster
├── base/                       all manifests, no namespace, no secrets
│   └── kustomization.yaml      resource list + ECR repository names
├── overlays/<env>/
│   ├── kustomization.yaml      namespace, image tag, replicas, secretGenerator
│   ├── namespace.yaml
│   └── secrets/*.env           real secret values (git-ignored)
└── secrets.example/*.env       templates for overlays/<env>/secrets/
```

`kubectl apply -k k8s/overlays/<env>` merges the base with that environment's
settings. To see the exact YAML without touching the cluster, run
`kubectl kustomize k8s/overlays/<env>`.

---

## 0. Install tools

| Tool | macOS | Windows | Check |
|---|---|---|---|
| AWS CLI v2 | `brew install awscli` | `choco install awscli -y` | `aws --version` |
| kubectl (includes Kustomize) | `brew install kubernetes-cli` | `choco install kubernetes-cli -y` | `kubectl version --client` |
| eksctl | `brew install eksctl` | `choco install eksctl -y` | `eksctl version` |
| Helm | `brew install helm` | `choco install kubernetes-helm -y` | `helm version` |
| Docker (with buildx) | Docker Desktop | Docker Desktop | `docker buildx version` |

Configure AWS credentials. The user needs permissions for EKS, EC2, IAM,
ECR and CloudFormation.

```bash
aws configure
aws sts get-caller-identity
```

## 1. Set variables

Every later command uses these, so run them in each new terminal:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=us-east-1
export CLUSTER_NAME=ecommerce
export REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
```

## 2. Create the EKS cluster

The three environments run about **34 pods** (dev 8, staging 13, prod 13)
plus system pods. Use at least **3 × t3.large** (35 pods and 8 GiB each).
`t3.medium` (17 pods) is too small.

```bash
eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --nodegroup-name workers \
  --node-type t3.large \
  --nodes 3 --nodes-min 3 --nodes-max 5 \
  --managed \
  --with-oidc
```

This takes about 15 to 20 minutes. eksctl also:
- creates a VPC with subnets tagged for load balancers;
- turns on IAM OIDC, which the add-ons below need;
- points kubectl at the new cluster.

To pin a Kubernetes version, add `--version <x.yy>`, and use one AWS still
supports.

Verify:

```bash
aws eks describe-cluster --name $CLUSTER_NAME --region $AWS_REGION --query cluster.status   # "ACTIVE"
kubectl config current-context        # must be the new cluster
kubectl get nodes -o wide             # 3 nodes, STATUS Ready

export VPC_ID=$(aws eks describe-cluster --name $CLUSTER_NAME --region $AWS_REGION \
  --query cluster.resourcesVpcConfig.vpcId --output text)
```

> **Existing cluster?** Set `CLUSTER_NAME` and `VPC_ID` to match it, and turn
> on OIDC:
> `eksctl utils associate-iam-oidc-provider --cluster $CLUSTER_NAME --region $AWS_REGION --approve`

## 3. Install the EBS CSI driver and StorageClass

This lets Kubernetes create EBS volumes for the MongoDB and RabbitMQ PVCs.
Without it, they stay `Pending` forever.

```bash
eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME --region $AWS_REGION \
  --namespace kube-system --name ebs-csi-controller-sa \
  --role-name AmazonEKS_EBS_CSI_DriverRole --role-only \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve

aws eks create-addon \
  --cluster-name $CLUSTER_NAME --region $AWS_REGION \
  --addon-name aws-ebs-csi-driver \
  --service-account-role-arn arn:aws:iam::$AWS_ACCOUNT_ID:role/AmazonEKS_EBS_CSI_DriverRole

aws eks wait addon-active --cluster-name $CLUSTER_NAME --region $AWS_REGION --addon-name aws-ebs-csi-driver
kubectl get csidrivers                # must list ebs.csi.aws.com
```

Apply the shared StorageClass (encrypted gp3, `WaitForFirstConsumer`) once:

```bash
kubectl apply -f k8s/cluster/
kubectl get storageclass              # ebs-gp3
```

## 4. Install the AWS Load Balancer Controller

This creates one ALB per environment's Ingress.

```bash
helm repo add eks https://aws.github.io/eks-charts && helm repo update

# Use the IAM policy that matches the chart version you're installing
LBC_VERSION=$(helm show chart eks/aws-load-balancer-controller | awk '/^appVersion:/ {print $2}')
curl -fsSLo iam_policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/$LBC_VERSION/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json
# "EntityAlreadyExists" means the policy exists already: reuse it, skip this command

eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME --region $AWS_REGION \
  --namespace kube-system --name aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=$CLUSTER_NAME \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=$AWS_REGION \
  --set vpcId=$VPC_ID

kubectl -n kube-system rollout status deploy/aws-load-balancer-controller --timeout=180s
kubectl get ingressclass              # must list "alb"
```

> **Wait for the rollout before step 8.** The controller registers a webhook
> for Services. Applying an environment while the controller isn't ready fails
> with `failed calling webhook ... elbv2.k8s.aws`.

**Check the subnet tags.** The controller only places an internet-facing ALB
in **public** subnets tagged `kubernetes.io/role/elb = 1`. eksctl adds these
tags; for a VPC you created yourself, add them by hand.

```bash
aws ec2 describe-subnets --region $AWS_REGION \
  --filters Name=vpc-id,Values=$VPC_ID Name=tag:kubernetes.io/role/elb,Values=1 \
  --query "Subnets[].[SubnetId,AvailabilityZone]" --output table
# Expect at least 2 subnets in different AZs
```

## 5. Build and push images to ECR

EKS nodes are **amd64**; Apple-silicon Macs build **arm64** by default. Always
build with `--platform linux/amd64`, or pods crash with `exec format error`.

The script creates the `ecommerce/<service>` ECR repositories if needed, logs
in, builds for amd64 and pushes api-gateway, user-service, product-service,
storefront and admin under the tag you give it. Push one tag per environment:

```bash
scripts/push-images.sh dev        # used by overlays/dev
scripts/push-images.sh staging    # used by overlays/staging
scripts/push-images.sh v1         # used by overlays/prod
```

<details>
<summary>Same thing by hand, for one service</summary>

```bash
aws ecr create-repository --repository-name ecommerce/user-service --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $REGISTRY

# Backend services build from the repo root (they copy proto/)
docker buildx build --platform linux/amd64 \
  -f services/user-service/Dockerfile \
  -t $REGISTRY/ecommerce/user-service:dev --push .

# Frontends build from their own folder
docker buildx build --platform linux/amd64 \
  -t $REGISTRY/ecommerce/storefront:dev --push frontends/storefront
```
</details>

MongoDB and RabbitMQ use the official public images, so there's nothing to
push for them.

```bash
aws ecr describe-images --repository-name ecommerce/api-gateway --region $AWS_REGION \
  --query "imageDetails[].imageTags" --output text      # dev staging v1
```

## 6. Point the manifests at your registry

The registry is set in `k8s/base/kustomization.yaml`, and the overlays match
on it. If your account or region is different from the original project's,
rewrite it in all of them:

```bash
grep -rl "573802369594.dkr.ecr.us-east-1.amazonaws.com" k8s | \
  xargs sed -i.bak "s|573802369594.dkr.ecr.us-east-1.amazonaws.com|$REGISTRY|g"
find k8s -name '*.bak' -delete
kubectl kustomize k8s/overlays/dev | grep "image:"     # check
```

## 7. Create secrets (per environment)

The secret values are not in git. Every environment needs its own set,
**with different values**, so a leaked dev password never unlocks prod.

```bash
for ENV in dev staging prod; do
  mkdir -p k8s/overlays/$ENV/secrets
  cp k8s/secrets.example/*.env k8s/overlays/$ENV/secrets/
done
```

Edit `k8s/overlays/<env>/secrets/*.env` for each environment:

| File | Keys | Notes |
|---|---|---|
| `mongodb-users.env` | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD` | Letters and digits only; it's embedded in `MONGO_URI` |
| `mongodb-products.env` | same | Use a different password |
| `rabbitmq.env` | `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` | Letters and digits only |
| `user-service.env` | `JWT_SECRET` | `openssl rand -hex 32`. **Never** `supersecretkey` |

Kustomize builds the Secrets from these files and adds a content hash to
each name, so changing a value later rolls the pods that use it. MongoDB and
RabbitMQ read their passwords **only on first start**, when the volume is
empty. Set them correctly before the first deploy.

## 8. Deploy an environment

Start with dev, then repeat for staging and prod:

```bash
export ENV=dev                                 # dev | staging | prod
kubectl config current-context                 # double-check the target cluster
kubectl kustomize k8s/overlays/$ENV | less     # optional: review what will be applied
kubectl apply -k k8s/overlays/$ENV
```

Then wait for everything to come up:

```bash
kubectl -n $ENV rollout status statefulset/mongodb-users    --timeout=300s
kubectl -n $ENV rollout status statefulset/mongodb-products --timeout=300s
kubectl -n $ENV rollout status statefulset/rabbitmq         --timeout=300s
kubectl -n $ENV wait --for=condition=available deploy --all --timeout=300s
```

On a cold start, user-service and product-service may **restart once**. They
exit on purpose when MongoDB isn't ready yet, then connect on the retry. That
is expected.

## 9. Verify an environment

```bash
kubectl -n $ENV get pods -o wide        # all Running, READY 1/1
kubectl -n $ENV get pvc                 # 3 × Bound
kubectl -n $ENV get svc                 # ClusterIP / headless (None) only
kubectl -n $ENV get endpoints           # every Service has pod IPs
kubectl -n $ENV get ingress frontends   # ADDRESS = this environment's ALB (2–3 min)
```

```bash
export APP_URL=http://$(kubectl -n $ENV get ingress frontends \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo $APP_URL                           # DNS can take another 1–2 min to resolve

scripts/smoke-test.sh $APP_URL          # all PASS; orders WARN (503) until order-service exists
```

| URL | What |
|---|---|
| `$APP_URL/` | Storefront |
| `$APP_URL/admin/` | Admin panel |
| `$APP_URL/api/products` | API |

The environments are fully separate. Users, products and admins created in
dev don't exist in staging or prod.

## 10. Create the first admin (per environment)

Register in that environment's storefront, then promote the user:

```bash
kubectl -n $ENV exec deploy/user-service -- node src/scripts/promoteAdmin.js you@example.com
```

Log out and back in, then open `$APP_URL/admin/`.

## 11. Releasing

| Environment | Steps |
|---|---|
| dev | `scripts/push-images.sh dev`, then `kubectl -n dev rollout restart deploy` |
| staging | `scripts/push-images.sh staging`, then `kubectl -n staging rollout restart deploy` |
| prod | `scripts/push-images.sh v2`, set `newTag: v2` for the images in `k8s/overlays/prod/kustomization.yaml`, commit, then `kubectl apply -k k8s/overlays/prod` |

dev and staging re-pull their moving tag on restart. Prod only changes when
its pinned tag changes, which makes a prod rollback a one-line revert. For
rollback and other operations, see [RUNBOOK.md](RUNBOOK.md).

## 12. Domains and HTTPS (optional)

Each environment has its own ALB, so give each one its own hostname, e.g.
`dev.shop.example.com`, `staging.shop.example.com`, `shop.example.com`.

1. Request a certificate in **ACM** covering the hostnames, in the same
   region, and validate it with DNS.
2. Add these annotations to `k8s/base/ingress.yaml`, then re-apply each
   overlay:
   ```yaml
   alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<AWS_REGION>:<AWS_ACCOUNT_ID>:certificate/<ID>
   alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
   alb.ingress.kubernetes.io/ssl-redirect: "443"
   ```
3. In **Route 53**, create an `A` record (alias) per hostname, pointing at
   that environment's ALB.

---

## Troubleshooting

| Symptom | Check | Usual fix |
|---|---|---|
| `kubectl apply -k` fails: `secrets/<name>.env: no such file` | `ls k8s/overlays/$ENV/secrets` | Create that environment's secrets (step 7) |
| Pod `ImagePullBackOff` | `kubectl -n $ENV describe pod <pod>` | Wrong registry (step 6), or that environment's tag not pushed (step 5) |
| Pod `CrashLoopBackOff`, logs say `exec format error` | `kubectl -n $ENV logs <pod> --previous` | Image built for arm64; rebuild with step 5 |
| PVC `Pending` | `kubectl -n $ENV describe pvc <pvc>` | EBS CSI driver missing, or StorageClass not applied (step 3) |
| Pods `Pending`, `Too many pods` / `Insufficient memory` | `kubectl describe nodes` | All three environments share the nodes; add nodes or use bigger ones |
| `apply` fails: `failed calling webhook ... elbv2.k8s.aws` | `kubectl -n kube-system get deploy aws-load-balancer-controller` | Wait until the controller is ready, then re-apply |
| Ingress `ADDRESS` stays empty | `kubectl -n kube-system logs deploy/aws-load-balancer-controller` | IAM policy or service account wrong (step 4), or subnets not tagged |
| `/api` returns 502/503 | EC2 console → Target groups → health | Gateway pods not ready; its health check must be `/health` |
| `/api/orders` returns 503 | — | Expected: order-service not deployed yet |
| Old code still running in dev or staging after a push | `kubectl -n $ENV rollout restart deploy` | Moving tags are only re-pulled when pods restart |
| Service has no endpoints | `kubectl -n $ENV get endpointslices` | Pods not Ready, or selector doesn't match pod labels |

General commands:

```bash
kubectl get ns                                         # dev, staging, prod
kubectl -n $ENV get events --sort-by=.lastTimestamp | tail -20
kubectl -n $ENV logs -f deploy/api-gateway
kubectl -n kube-system get pods | grep -E "ebs|load-balancer"
```

---

## Tear down

**One environment.** Delete the Ingress first, so the controller removes
that environment's ALB. Deleting the overlay also deletes the namespace, its
PVCs and their EBS volumes (**data is lost**).

```bash
kubectl -n $ENV delete ingress frontends
sleep 60
kubectl delete -k k8s/overlays/$ENV
```

**Everything.** Remove all three environments as above, then:

```bash
kubectl delete -f k8s/cluster/
helm uninstall aws-load-balancer-controller -n kube-system
eksctl delete cluster --name $CLUSTER_NAME --region $AWS_REGION

# Optional: remove images and the IAM policy
for r in api-gateway user-service product-service storefront admin; do
  aws ecr delete-repository --repository-name ecommerce/$r --region $AWS_REGION --force
done
aws iam delete-policy --policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy
```

Deleting the cluster before the Ingresses leaves the ALBs and their security
groups orphaned in your account, and still billing.

**Cost while running:** the EKS control plane, 3+ EC2 nodes, three ALBs (one
per environment), and 9 × 1Gi gp3 volumes, plus ECR storage.

---

## Key concepts, mapped to this repo

| Concept | Role | In this repo |
|---|---|---|
| ECR | Stores the Docker images | `ecommerce/<service>:<tag>`, pushed by `scripts/push-images.sh` |
| EKS | Runs Kubernetes | Created in step 2 |
| Namespace | Isolates one environment's objects | `dev`, `staging`, `prod` (`k8s/overlays/<env>/namespace.yaml`) |
| Kustomize base / overlay | Shared manifests + per-environment changes | `k8s/base/`, `k8s/overlays/<env>/` |
| Deployment | Stateless pods, replaceable and scalable | user, product, gateway, storefront, admin |
| StatefulSet | Stable pod name and storage per pod | MongoDB ×2, RabbitMQ (per environment) |
| PVC | A pod's request for storage | `volumeClaimTemplates` in each StatefulSet |
| StorageClass | How storage is provisioned | `ebs-gp3`, `k8s/cluster/storageclass.yaml` |
| EBS CSI driver | Turns PVCs into EBS volumes | Installed in step 3 |
| ClusterIP Service | Stable internal address for pods | All app Services |
| Headless Service | DNS name per StatefulSet pod (`mongodb-users-0.mongodb-users`) | MongoDB, RabbitMQ |
| Ingress | HTTP routing rules | `k8s/base/ingress.yaml`, one ALB per environment |
| AWS Load Balancer Controller | Creates and manages the ALBs from the Ingresses | Installed in step 4 |
| ConfigMap / Secret | Configuration / credentials as env vars | `*/configmap.yaml`; Secrets generated from `overlays/<env>/secrets/*.env` |
