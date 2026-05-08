#!/bin/bash
# Instala k3d, kubectl e helm, depois sobe o cluster e deploya tudo
set -e

echo "==> Instalando kubectl..."
curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/kubectl

echo "==> Instalando k3d..."
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

echo "==> Instalando helm..."
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

echo "==> Criando cluster k3d..."
k3d cluster create apm-cluster \
  --port "3000:30000@loadbalancer" \
  --agents 1

echo "==> Aguardando cluster ficar pronto..."
kubectl wait --for=condition=Ready nodes --all --timeout=60s

echo "==> Adicionando repo Helm do Datadog..."
helm repo add datadog https://helm.datadoghq.com
helm repo update

echo ""
echo "Cluster pronto! Agora execute:"
echo "  ./deploy.sh <SUA_DD_API_KEY>"
