# Kubernetes manifests (EKS): dev, staging, prod

Kustomize base plus one overlay per environment, each in its own namespace.
**Full step-by-step instructions, from an empty AWS account to running
environments: [docs/EKS-DEPLOYMENT.md](../docs/EKS-DEPLOYMENT.md).**

```
k8s/
├── cluster/storageclass.yaml   gp3 EBS StorageClass "ebs-gp3", shared, apply once
├── base/                       manifests shared by every environment (no namespace, no secrets)
│   ├── kustomization.yaml      resource list + ECR repository names
│   ├── mongodb-users/  mongodb-products/  rabbitmq/      StatefulSets + headless Services
│   ├── user-service/  product-service/  api-gateway/    Deployments + ClusterIP Services
│   ├── storefront/  admin/                               Deployments + ClusterIP Services
│   └── ingress.yaml            ALB: /api → api-gateway, /admin → admin, / → storefront
├── overlays/
│   ├── dev/        namespace dev,     tag "dev",     1 replica,  pull Always
│   ├── staging/    namespace staging, tag "staging", 2 replicas, pull Always
│   └── prod/       namespace prod,    tag "v1",      2 replicas (bump newTag to release)
│       └── secrets/*.env       real secret values per environment (git-ignored)
└── secrets.example/*.env       templates for overlays/<env>/secrets/
```

- **Change something for every environment:** edit `base/`.
- **Change one environment:** edit its `overlays/<env>/kustomization.yaml`.
- **Preview** the output without touching the cluster:
  `kubectl kustomize k8s/overlays/<env>`.

Quick deploy, once the cluster has the EBS CSI driver and the AWS Load
Balancer Controller (guide steps 2–4):

```bash
kubectl apply -f k8s/cluster/
scripts/push-images.sh dev
mkdir -p k8s/overlays/dev/secrets && cp k8s/secrets.example/*.env k8s/overlays/dev/secrets/   # then edit
kubectl apply -k k8s/overlays/dev
kubectl -n dev get pods,pvc,ingress
```

Not yet included: order-service, notification-service, mongodb-orders.
