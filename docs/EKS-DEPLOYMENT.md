# EKS deployment guide (single namespace)

This guide deploys ShopLite to AWS EKS, from an empty AWS account to a working
URL, with everything in one namespace: `ecommerce`.

It uses Docker, Amazon ECR, Amazon EKS, Deployments, StatefulSets, PVCs, the
EBS CSI driver, ClusterIP Services, the AWS Load Balancer Controller and an
Ingress.

> All commands are bash. On Windows, use **Git Bash** or **WSL**.
> Placeholders look like `<THIS>`; the shell variables set in
> [step 1](#1-set-variables) fill most of them in for you.

---

## What gets deployed

```
                       Internet
                          │
                          ▼
           ┌──────────────────────────────┐
           │  ALB (AWS Load Balancer      │   one Ingress: "frontends"
           │  Controller, from Ingress)   │
           └───┬──────────┬───────────┬───┘
         /api/*│   /admin/*│         /*│
               ▼           ▼           ▼
        ┌───────────┐ ┌─────────┐ ┌────────────┐
        │api-gateway│ │  admin  │ │ storefront │   Deployments (2 replicas)
        │  :3000    │ │ nginx:80│ │  nginx:80  │   ClusterIP Services
        └─────┬─────┘ └─────────┘ └────────────┘
              │ gRPC
      ┌───────┴────────┐
      ▼                ▼
┌─────────────┐  ┌───────────────┐
│user-service │  │product-service│               Deployments (2 replicas)
│   :50051    │  │    :50052     │               ClusterIP Services
└──────┬──────┘  └───────┬───────┘
       ▼                 ▼
┌─────────────┐  ┌────────────────┐  ┌──────────┐
│mongodb-users│  │mongodb-products│  │ rabbitmq │ StatefulSets (1 replica)
│  headless   │  │   headless     │  │          │ headless Services
└──────┬──────┘  └───────┬────────┘  └────┬─────┘
      PVC               PVC              PVC      gp3 EBS volumes (1Gi)
```

| Kind | Objects |
|---|---|
| Namespace | `ecommerce` |
| StorageClass | `ebs-gp3` (cluster-wide) |
| StatefulSet + headless Service + PVC | `mongodb-users`, `mongodb-products`, `rabbitmq` |
| Deployment + ClusterIP Service | `user-service`, `product-service`, `api-gateway`, `storefront`, `admin` |
| Ingress (ALB) | `frontends`: `/api` → api-gateway, `/admin` → admin, `/` → storefront |
| Secrets | `mongodb-users-secret`, `mongodb-products-secret`, `rabbitmq-secret`, `user-service-secret` |

**Not deployed yet:** order-service, notification-service, mongodb-orders.
Until they exist, signup, login, products, the cart and admin product
management work, but placing or listing orders returns **503**.

Only the frontends and `/api` are reachable from the internet. The gRPC
services, databases and RabbitMQ are ClusterIP or headless, so they can only
be reached inside the cluster.

---

## 0. Install tools

| Tool | macOS | Windows | Check |
|---|---|---|---|
| AWS CLI v2 | `brew install awscli` | `choco install awscli -y` | `aws --version` |
| kubectl | `brew install kubernetes-cli` | `choco install kubernetes-cli -y` | `kubectl version --client` |
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

The stack runs 13 pods (3 stateful + 5 Deployments × 2) plus system pods. `t3.medium` fits 17 pods per node,
so use 2 nodes minimum. A `t3.small` (11 pods) is too small.

```bash
eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --nodegroup-name workers \
  --node-type t3.medium \
  --nodes 2 --nodes-min 2 --nodes-max 4 \
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
kubectl get nodes -o wide             # 2 nodes, STATUS Ready

export VPC_ID=$(aws eks describe-cluster --name $CLUSTER_NAME --region $AWS_REGION \
  --query cluster.resourcesVpcConfig.vpcId --output text)
```

> **Existing cluster?** Set `CLUSTER_NAME` and `VPC_ID` to match it, and turn
> on OIDC:
> `eksctl utils associate-iam-oidc-provider --cluster $CLUSTER_NAME --region $AWS_REGION --approve`

## 3. Install the EBS CSI driver

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

The repo provides the StorageClass (`k8s/00-storageclass.yaml`: encrypted
gp3, `WaitForFirstConsumer`). It's applied together with the app in step 8.

## 4. Install the AWS Load Balancer Controller

This creates the ALB from the Ingress.

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
> for Services. Applying the app while the controller isn't ready fails with
> `failed calling webhook ... elbv2.k8s.aws`.

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

The script creates the ECR repositories if needed, logs in, builds for amd64
and pushes `dev/<service>:v1` for api-gateway, user-service, product-service,
storefront and admin:

```bash
scripts/push-images.sh v1
```

<details>
<summary>Same thing by hand, for one service</summary>

```bash
aws ecr create-repository --repository-name dev/user-service --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $REGISTRY

# Backend services build from the repo root (they copy proto/)
docker buildx build --platform linux/amd64 \
  -f services/user-service/Dockerfile \
  -t $REGISTRY/dev/user-service:v1 --push .

# Frontends build from their own folder
docker buildx build --platform linux/amd64 \
  -t $REGISTRY/dev/storefront:v1 --push frontends/storefront
```
</details>

MongoDB and RabbitMQ use the official public images, so there's nothing to
push for them.

```bash
aws ecr describe-images --repository-name dev/api-gateway --region $AWS_REGION \
  --query "imageDetails[].imageTags" --output text      # v1
```

## 6. Point the manifests at your registry

The Deployments reference the original project account. If your account or
region is different, rewrite the image registry:

```bash
grep -rl "573802369594.dkr.ecr.us-east-1.amazonaws.com" k8s | \
  xargs sed -i.bak "s|573802369594.dkr.ecr.us-east-1.amazonaws.com|$REGISTRY|g"
find k8s -name '*.bak' -delete
grep -rh "image:" k8s/*/deployment.yaml      # check
```

## 7. Create secrets

The secret values are not in git. Create them from the templates:

```bash
for d in mongodb-users mongodb-products user-service rabbitmq; do
  cp k8s/$d/secret.yaml.example k8s/$d/secret.yaml
done
```

Edit the four `k8s/*/secret.yaml` files:

| File | Keys | Notes |
|---|---|---|
| `mongodb-users/secret.yaml` | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD` | Letters and digits only; it's embedded in `MONGO_URI` |
| `mongodb-products/secret.yaml` | same | Use a different password |
| `rabbitmq/secret.yaml` | `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` | Letters and digits only |
| `user-service/secret.yaml` | `JWT_SECRET` | `openssl rand -hex 32`. **Never** `supersecretkey` |

MongoDB and RabbitMQ read these passwords **only on first start**, when the
volume is empty. Set them correctly before the first deploy.

## 8. Deploy

```bash
kubectl config current-context               # double-check the target cluster
kubectl apply -R -f k8s/
```

Files are applied alphabetically: the `00-` files (namespace, StorageClass)
first, then everything else. Then wait for everything to come up:

```bash
kubectl -n ecommerce rollout status statefulset/mongodb-users    --timeout=300s
kubectl -n ecommerce rollout status statefulset/mongodb-products --timeout=300s
kubectl -n ecommerce rollout status statefulset/rabbitmq         --timeout=300s
kubectl -n ecommerce wait --for=condition=available deploy --all --timeout=300s
```

On a cold start, user-service and product-service may **restart once**. They
exit on purpose when MongoDB isn't ready yet, then connect on the retry. That
is expected.

## 9. Verify

```bash
kubectl -n ecommerce get pods -o wide        # all Running, READY 1/1
kubectl -n ecommerce get pvc                 # 3 × Bound
kubectl get pv                               # matching gp3 volumes
kubectl -n ecommerce get svc                 # ClusterIP / headless (None) only
kubectl -n ecommerce get endpoints           # every Service has pod IPs
kubectl -n ecommerce get ingress frontends   # ADDRESS = ALB hostname (2–3 min)
```

```bash
export APP_URL=http://$(kubectl -n ecommerce get ingress frontends \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo $APP_URL                                # DNS can take another 1–2 min to resolve

scripts/smoke-test.sh $APP_URL               # all PASS; orders WARN (503) until order-service exists
```

| URL | What |
|---|---|
| `$APP_URL/` | Storefront |
| `$APP_URL/admin/` | Admin panel |
| `$APP_URL/api/products` | API |

## 10. Create the first admin

Register in the storefront, then promote that user:

```bash
kubectl -n ecommerce exec deploy/user-service -- node src/scripts/promoteAdmin.js you@example.com
```

Log out and back in, then open `$APP_URL/admin/`.

## 11. Domain and HTTPS (optional)

1. Request a certificate in **ACM** for `shop.example.com`, in the same
   region, and validate it with DNS.
2. Add these annotations to `k8s/ingress.yaml`, then re-apply:
   ```yaml
   alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<AWS_REGION>:<AWS_ACCOUNT_ID>:certificate/<ID>
   alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
   alb.ingress.kubernetes.io/ssl-redirect: "443"
   ```
3. In **Route 53**, create an `A` record (alias) from `shop.example.com` to
   the ALB hostname.

---

## Troubleshooting

| Symptom | Check | Usual fix |
|---|---|---|
| Pod `ImagePullBackOff` | `kubectl -n ecommerce describe pod <pod>` | Wrong registry in manifests (step 6), or image not pushed (step 5) |
| Pod `CrashLoopBackOff`, logs say `exec format error` | `kubectl -n ecommerce logs <pod> --previous` | Image built for arm64; rebuild with step 5 |
| Pod `CreateContainerConfigError` | `kubectl -n ecommerce get secrets` | Secrets missing (step 7) |
| PVC `Pending` | `kubectl -n ecommerce describe pvc <pvc>` | EBS CSI driver missing (step 3) |
| Pods `Pending`, `Too many pods` | `kubectl describe nodes` | Add nodes or use bigger instances |
| `apply` fails: `failed calling webhook ... elbv2.k8s.aws` | `kubectl -n kube-system get deploy aws-load-balancer-controller` | Wait until the controller is ready, then re-apply |
| Ingress `ADDRESS` stays empty | `kubectl -n kube-system logs deploy/aws-load-balancer-controller` | IAM policy or service account wrong (step 4), or subnets not tagged |
| `/api` returns 502/503 | EC2 console → Target groups → health | Gateway pods not ready; its health check must be `/health` |
| `/api/orders` returns 503 | — | Expected: order-service not deployed yet |
| Service has no endpoints | `kubectl -n ecommerce get endpointslices` | Pods not Ready, or selector doesn't match pod labels |

General commands:

```bash
kubectl -n ecommerce get events --sort-by=.lastTimestamp | tail -20
kubectl -n ecommerce logs -f deploy/api-gateway
kubectl -n ecommerce describe statefulset mongodb-users
kubectl -n kube-system get pods | grep -E "ebs|load-balancer"
```

For operations after the deploy (releases, rollback, secret rotation,
backups), see [RUNBOOK.md](RUNBOOK.md).

---

## Tear down

Delete in this order. The ALB, its security groups and the EBS volumes are
AWS resources owned by Kubernetes controllers. Deleting the cluster first
leaves them orphaned, and still billing.

```bash
kubectl -n ecommerce delete ingress frontends    # controller deletes the ALB
sleep 60
kubectl delete -R -f k8s/                         # namespace, PVCs → EBS volumes deleted
helm uninstall aws-load-balancer-controller -n kube-system
eksctl delete cluster --name $CLUSTER_NAME --region $AWS_REGION

# Optional: remove images and the IAM policy
for r in api-gateway user-service product-service storefront admin; do
  aws ecr delete-repository --repository-name dev/$r --region $AWS_REGION --force
done
aws iam delete-policy --policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy
```

**Cost while running:** the EKS control plane, the EC2 nodes, one ALB, and
3 × 1Gi gp3 volumes, plus ECR storage.

---

## Key concepts, mapped to this repo

| Concept | Role | In this repo |
|---|---|---|
| ECR | Stores the Docker images | `dev/<service>`, pushed by `scripts/push-images.sh` |
| EKS | Runs Kubernetes | Created in step 2 |
| Namespace | Groups and isolates the app's objects | `k8s/00-namespace.yaml` → `ecommerce` |
| Deployment | Stateless pods, replaceable and scalable | user, product, gateway, storefront, admin |
| StatefulSet | Stable pod name and storage per pod | MongoDB ×2, RabbitMQ |
| PVC | A pod's request for storage | `volumeClaimTemplates` in each StatefulSet |
| StorageClass | How storage is provisioned | `ebs-gp3`, `k8s/00-storageclass.yaml` |
| EBS CSI driver | Turns PVCs into EBS volumes | Installed in step 3 |
| ClusterIP Service | Stable internal address for pods | All app Services |
| Headless Service | DNS name per StatefulSet pod (`mongodb-users-0.mongodb-users`) | MongoDB, RabbitMQ |
| Ingress | HTTP routing rules | `k8s/ingress.yaml` |
| AWS Load Balancer Controller | Creates and manages the ALB from the Ingress | Installed in step 4 |
| ConfigMap / Secret | Configuration / credentials as env vars | `*/configmap.yaml`, `*/secret.yaml` |
