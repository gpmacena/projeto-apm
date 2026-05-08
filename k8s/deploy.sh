#!/bin/bash
# Builda a imagem, sobe o Datadog Agent e a aplicação no cluster
set -e

DD_API_KEY=${1:-""}

if [ -z "$DD_API_KEY" ]; then
  echo "Uso: ./deploy.sh <SUA_DD_API_KEY>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Buildando imagem da aplicação..."
k3d image import --cluster apm-cluster $(docker build -q "$ROOT_DIR" -f "$SCRIPT_DIR/Dockerfile")
# Taga a imagem para o nome que o deployment espera
docker build -t minha-api:latest "$ROOT_DIR" -f "$SCRIPT_DIR/Dockerfile"
k3d image import minha-api:latest --cluster apm-cluster

echo "==> Instalando Datadog Agent via Helm..."
helm upgrade --install datadog-agent datadog/datadog \
  --namespace datadog \
  --create-namespace \
  --set datadog.apiKey="$DD_API_KEY" \
  --set datadog.apm.portEnabled=true \
  --set datadog.logs.enabled=true \
  --set datadog.logs.containerCollectAll=true \
  --set datadog.site="datadoghq.com" \
  --set agents.image.tag="7" \
  --wait --timeout 120s

echo "==> Aplicando manifestos da aplicação..."
kubectl apply -f "$SCRIPT_DIR/namespace.yaml"
kubectl apply -f "$SCRIPT_DIR/deployment.yaml"
kubectl apply -f "$SCRIPT_DIR/service.yaml"

echo "==> Aguardando deploy ficar pronto..."
kubectl rollout status deployment/minha-api -n minha-api --timeout=60s

echo ""
echo "Tudo pronto!"
echo "Aplicação: http://localhost:3000"
echo "Gerar carga: kubectl exec -n minha-api deploy/minha-api -- node load-generator.js 200 5"
