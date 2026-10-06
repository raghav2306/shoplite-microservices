#!/usr/bin/env bash
# Builds linux/amd64 images (EKS default node architecture) and pushes them to ECR
# as ecommerce/<service>:<tag>.
# Usage: scripts/push-images.sh <tag>
#   scripts/push-images.sh dev       -> picked up by k8s/overlays/dev on next rollout
#   scripts/push-images.sh staging   -> k8s/overlays/staging
#   scripts/push-images.sh v2        -> release; set newTag: v2 in k8s/overlays/prod
set -euo pipefail

TAG="${1:?Usage: $0 <tag>   (dev | staging | release version e.g. v2)}"
ACCOUNT=573802369594
REGION=us-east-1
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
PLATFORM=linux/amd64

cd "$(dirname "$0")/.."

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# name | build context | Dockerfile
IMAGES=(
  "api-gateway|.|services/api-gateway/Dockerfile"
  "user-service|.|services/user-service/Dockerfile"
  "product-service|.|services/product-service/Dockerfile"
  "storefront|frontends/storefront|frontends/storefront/Dockerfile"
  "admin|frontends/admin|frontends/admin/Dockerfile"
)

for entry in "${IMAGES[@]}"; do
  IFS="|" read -r name context dockerfile <<<"$entry"
  repo="ecommerce/$name"

  aws ecr describe-repositories --region "$REGION" --repository-names "$repo" >/dev/null 2>&1 ||
    aws ecr create-repository --region "$REGION" --repository-name "$repo" >/dev/null

  echo "==> $REGISTRY/$repo:$TAG ($PLATFORM)"
  docker buildx build --platform "$PLATFORM" -f "$dockerfile" -t "$REGISTRY/$repo:$TAG" --push "$context"
done
