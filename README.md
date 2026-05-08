# Datadog APM — Guia de Instrumentação Node.js no Kubernetes

Aplicação de estudo para aprender instrumentação com Datadog APM em ambiente Kubernetes local (k3d), simulando um cluster real.

---

## Estrutura do projeto

```
aplication-apm/
├── app.js                  # Aplicação Express (sem instrumentação — ponto de partida)
├── load-generator.js       # Gerador de carga para popular o APM
├── package.json
├── .env.example
└── k8s/
    ├── setup.sh            # Instala kubectl, k3d e helm
    ├── Dockerfile          # Imagem da aplicação
    ├── namespace.yaml
    ├── deployment.yaml
    ├── service.yaml
    └── datadog-agent.yaml  # CR do Datadog Operator
```

---

## Como o Datadog APM funciona

```
Sua aplicação (Node.js)
        │  envia traces via dd-trace
        ▼
Datadog Agent (DaemonSet no cluster — um pod por nó)
        │  porta 8126 (APM) | 8125 (métricas)
        ▼
Datadog Backend (us5.datadoghq.com)
        │
        ▼
APM → Traces / Services / Service Map
```

**Trace** = jornada completa de uma requisição (`trace_id`).  
**Span** = uma operação dentro do trace (`span_id` + `parent_id`).  
**Tag** = metadado chave:valor em qualquer span (ex: `pedido.id=42`).

---

## Pré-requisitos

- Docker instalado
- Conta no Datadog com API Key (`app.datadoghq.com → Organization Settings → API Keys`)

---

## Parte 1 — Preparar o ambiente local

### 1.1 Instalar kubectl, k3d e helm

```bash
chmod +x k8s/setup.sh && ./k8s/setup.sh
```

Ou manualmente:

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/kubectl

# k3d
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### 1.2 Criar o cluster Kubernetes local

```bash
k3d cluster create apm-cluster --port "3000:30000@loadbalancer" --agents 1
kubectl wait --for=condition=Ready nodes --all --timeout=90s
kubectl get nodes
```

Resultado esperado:
```
NAME                       STATUS   ROLES                  AGE
k3d-apm-cluster-agent-0    Ready    <none>
k3d-apm-cluster-server-0   Ready    control-plane,master
```

---

## Parte 2 — Instalar o Datadog Agent no cluster

### 2.1 No painel do Datadog (feito manualmente)

1. Acesse `app.datadoghq.com`
2. **Get Started → Infrastructure & backend applications**
3. **Install the Datadog Agent on Kubernetes**
4. Método: **Datadog Operator**
5. Distribuição: **Self Managed**
6. Coverage: marcar **APM** e **Log Management** | Environment: `local`

### 2.2 Instalar o Datadog Operator via Helm

```bash
helm repo add datadog https://helm.datadoghq.com
helm repo update
helm install datadog-operator datadog/datadog-operator --namespace datadog --create-namespace
```

### 2.3 Criar o secret com a API Key

> Substitua `<SUA_API_KEY>` pela key gerada em `Organization Settings → API Keys`

```bash
kubectl create secret generic datadog-secret \
  --from-literal api-key=<SUA_API_KEY> \
  -n datadog
```

### 2.4 Criar o arquivo do Agent

O wizard do Datadog gera o conteúdo. O arquivo já está em `k8s/datadog-agent.yaml` com as configurações corretas para este projeto:

```yaml
kind: DatadogAgent
apiVersion: datadoghq.com/v2alpha1
metadata:
  name: datadog
  namespace: datadog
spec:
  global:
    clusterName: "apm-cluster"
    site: "us5.datadoghq.com"       # ajuste para o seu site (us1, eu1, etc.)
    credentials:
      apiSecret:
        secretName: "datadog-secret"
        keyName: "api-key"
    tags:
      - "env:local"
  features:
    apm:
      instrumentation:
        enabled: true
        targets:
          - name: "default-target"
            ddTraceVersions:
              js: "5"
    logCollection:
      enabled: true
      containerCollectAll: true
```

Aplicar:
```bash
kubectl apply -f k8s/datadog-agent.yaml
```

### 2.5 Verificar se o Agent subiu

```bash
kubectl get pods -n datadog
```

Resultado esperado (aguardar ~2 minutos):
```
NAME                                     READY   STATUS
datadog-agent-xxxxx                      2/2     Running
datadog-agent-yyyyy                      2/2     Running
datadog-cluster-agent-xxxxxxxxx-xxxxx    1/1     Running
datadog-operator-xxxxxxxxx-xxxxx         1/1     Running
```

---

## Parte 3 — Subir a aplicação no cluster

### 3.1 Buildar a imagem e importar para o k3d

```bash
docker build -t minha-api:latest -f k8s/Dockerfile .
k3d image import minha-api:latest --cluster apm-cluster
```

### 3.2 Aplicar os manifestos

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### 3.3 Verificar se a aplicação subiu

```bash
kubectl rollout status deployment/minha-api -n minha-api
kubectl get pods -n minha-api
```

### 3.4 Testar

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

---

## Parte 4 — Instrumentar com Datadog APM (do zero)

> A aplicação em `app.js` está **sem instrumentação**. Este é o ponto de partida para o estudo.

### 4.1 Instalar o dd-trace

```bash
npm install dd-trace
```

### 4.2 Inicializar o tracer (primeira linha do app.js)

```js
// DEVE ser o primeiro require — antes de express, http, etc.
const tracer = require('dd-trace').init({
  service: 'minha-api',
  env: 'local',
  version: '1.0.0',
  logInjection: true,
  runtimeMetrics: true,
});
```

### 4.3 Span manual (operação de banco, chamada externa, etc.)

```js
const span = tracer.startSpan('db.query', {
  childOf: tracer.scope().active(),
  tags: {
    'db.type': 'postgresql',
    'db.statement': 'SELECT * FROM produtos',
  },
});
await minhaOperacao();
span.finish(); // sempre chame finish()
```

### 4.4 Tag no span ativo (contexto de negócio)

```js
const span = tracer.scope().active();
span.setTag('pedido.id', req.params.id);
```

### 4.5 Marcar erro no span

```js
span.setTag('error', true);
span.setTag('error.message', err.message);
span.setTag('error.type', err.constructor.name);
span.setTag('error.stack', err.stack);
```

### 4.6 Rebuild e redeploy após instrumentar

```bash
docker build -t minha-api:latest -f k8s/Dockerfile .
k3d image import minha-api:latest --cluster apm-cluster
kubectl rollout restart deployment/minha-api -n minha-api
```

### 4.7 Gerar tráfego

```bash
# De fora do cluster
node load-generator.js 200 5

# Ou de dentro do pod
kubectl exec -n minha-api deploy/minha-api -- node load-generator.js 200 5
```

---

## Parte 5 — Ver os resultados no Datadog

Após gerar tráfego, acesse `app.datadoghq.com`:

| O que ver | Onde |
|---|---|
| Traces e flame graph | APM → Traces → filtrar `service:minha-api` |
| Latência p50/p95/p99 | APM → Services → minha-api |
| Taxa de erro | APM → Services → minha-api → Errors |
| Métricas de runtime Node.js | APM → Services → Runtime Metrics |
| Mapa de dependências | APM → Service Map |
| Logs correlacionados com traces | Logs → clicar em "View Trace" |

---

## Rotas disponíveis para teste

| Rota | O que simula |
|---|---|
| `GET /health` | Rota rápida — baseline de latência |
| `GET /produtos?categoria=x` | Tag customizada no span |
| `GET /pedidos/:id` | Múltiplos spans filhos em cascata |
| `GET /relatorio` | Rota lenta (800ms) — aparece no p99 |
| `GET /falha` | Erro controlado — span vermelho |
| `GET /instavel` | ~30% de erro — taxa de erro variável |

---

## Comandos úteis do dia a dia

```bash
# Ver pods de tudo
kubectl get pods -n datadog
kubectl get pods -n minha-api

# Logs da aplicação
kubectl logs -n minha-api deploy/minha-api -f

# Logs do Datadog Agent
kubectl logs -n datadog -l app.kubernetes.io/component=agent -f

# Reiniciar a aplicação após mudança de código
docker build -t minha-api:latest -f k8s/Dockerfile . && \
k3d image import minha-api:latest --cluster apm-cluster && \
kubectl rollout restart deployment/minha-api -n minha-api

# Destruir o cluster (recomeçar do zero)
k3d cluster delete apm-cluster
```
