# Kubernetes manifests (EKS)

Plain YAML for the `ecommerce` namespace. **Full step-by-step instructions,
from an empty AWS account to a running app:
[docs/EKS-DEPLOYMENT.md](../docs/EKS-DEPLOYMENT.md).**

```
k8s/
├── 00-namespace.yaml        namespace "ecommerce"
├── 00-storageclass.yaml     gp3 EBS StorageClass "ebs-gp3" (needs the EBS CSI driver)
├── mongodb-users/           StatefulSet + headless Service + secret template
├── mongodb-products/        StatefulSet + headless Service + secret template
├── rabbitmq/                StatefulSet + ClusterIP & headless Services + secret template
├── user-service/            Deployment + ClusterIP Service + ConfigMap + secret template
├── product-service/         Deployment + ClusterIP Service + ConfigMap
├── api-gateway/             Deployment + ClusterIP Service + ConfigMap
├── storefront/              Deployment + ClusterIP Service
├── admin/                   Deployment + ClusterIP Service
└── ingress.yaml             ALB: /api → api-gateway, /admin → admin, / → storefront
```

Quick deploy, once the cluster has the EBS CSI driver and the AWS Load
Balancer Controller (guide steps 2–4):

```bash
scripts/push-images.sh v1
for d in mongodb-users mongodb-products user-service rabbitmq; do
  cp k8s/$d/secret.yaml.example k8s/$d/secret.yaml      # then edit the values
done
kubectl apply -R -f k8s/
kubectl -n ecommerce get pods,pvc,ingress
```

The `secret.yaml` files are git-ignored. Only the `.example` templates are
committed.

Not yet included: order-service, notification-service, mongodb-orders.
