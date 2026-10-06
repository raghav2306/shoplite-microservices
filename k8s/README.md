# Deploying to EKS

Manifests here: namespace, gp3 StorageClass, mongodb-users, mongodb-products,
rabbitmq, user-service, product-service, api-gateway, storefront, admin, and one ALB Ingress
(`/api` goes to the gateway, `/admin/` to the admin app, everything else to the storefront).

Not yet included: order-service, notification-service, mongodb-orders.
Until they exist, signup, login, products and the cart work, but placing or
listing orders returns 503.

## 1. Cluster prerequisites (one time)

The commands assume a cluster named `ecommerce` in `us-east-1`.

**Cluster.** Use at least 2 × `t3.medium`. A `t3.small` fits only 11 pods per
node, which is too few for these 15 pods plus the system pods.

```bash
eksctl create cluster --name ecommerce --region us-east-1 \
  --nodegroup-name workers --node-type t3.medium --nodes 2 --with-oidc
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

**AWS Load Balancer Controller.** This turns the Ingress into an ALB. Without
it the Ingress never gets an address.

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

## 2. Push images

Your Mac builds arm64 images by default, but EKS nodes are amd64. This script
builds amd64 images and pushes them to ECR as `dev/<service>:v1`:

```bash
scripts/push-images.sh
```

If you push a new build under the same tag, nodes keep the copy they already
pulled (`imagePullPolicy: IfNotPresent`). Use a new tag instead, e.g.
`scripts/push-images.sh v2`, and update the `image:` lines.

## 3. Secrets

```bash
for d in mongodb-users mongodb-products user-service rabbitmq; do
  cp k8s/$d/secret.yaml.example k8s/$d/secret.yaml
done
```

Edit the values. Use letters and digits only for the passwords, because they
are embedded in connection URLs. The `secret.yaml` files are git-ignored.

MongoDB and RabbitMQ create their users only on first start, when the volume
is empty. If you change those passwords later, delete the PVCs as well.

## 4. Deploy

```bash
kubectl config current-context        # make sure this is the EKS cluster
kubectl apply -R -f k8s/
kubectl -n ecommerce get pods,pvc,ingress
```

On a cold start, user-service and product-service may restart once while
MongoDB starts up. That is expected.

The ALB hostname appears in the `ADDRESS` column after about 2 to 3 minutes.
The shop is at `http://<hostname>/`, the admin panel at `http://<hostname>/admin/`,
and the API at `http://<hostname>/api/`.

## Cleanup

Delete the Ingress first, so the controller removes the ALB. Then delete
the namespace, which also deletes the PVCs and their EBS volumes.

```bash
kubectl -n ecommerce delete ingress --all
kubectl delete -R -f k8s/
```
