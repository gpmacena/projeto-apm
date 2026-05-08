# Datadog APM — Guia de Instrumentação Node.js no Kubernetes

Aplicação de estudo para aprender instrumentação com Datadog APM em ambiente Kubernetes local (k3d), simulando um cluster real.

---

## Estrutura do projeto

```
aplication-apm/
├── app.js                  # Aplicação Express instrumentada com dd-trace
├── load-generator.js       # Gerador de carga para popular o APM
├── package.json
├── .env.example
└── k8s/
    ├── Dockerfile          # Imagem da aplicação
    ├── namespace.yaml
    ├── deployment.yaml
    ├── service.yaml
    └── datadog-agent.yaml  # CR do Datadog Operator
```

---

## Como o Datadog APM funciona

```
Sua aplicação (Node.js + dd-trace)
        │  envia traces via HTTP
        ▼
Datadog Agent (DaemonSet — um pod por nó do cluster)
        │  porta 8126 (APM) | 8125 (métricas StatsD)
        ▼
Datadog Backend (us5.datadoghq.com)
        │
        ▼
APM → Traces / Services / Service Map / Dashboards
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
NAME                       STATUS   ROLES
k3d-apm-cluster-agent-0    Ready    <none>
k3d-apm-cluster-server-0   Ready    control-plane,master
```

---

## Parte 2 — Instalar o Datadog Agent no cluster

### 2.1 No painel do Datadog (manual)

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

### 2.4 Aplicar o arquivo do Agent

```bash
kubectl apply -f k8s/datadog-agent.yaml
```

O arquivo já está configurado com APM e Log Collection habilitados para o cluster `apm-cluster`.

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

### 3.3 Verificar

```bash
kubectl rollout status deployment/minha-api -n minha-api
curl http://localhost:3000/health
# {"status":"ok","timestamp":"..."}
```

---

## Parte 4 — Instrumentação com dd-trace

### 4.1 O que é o dd-trace

Biblioteca oficial do Datadog para Node.js. Faz dois trabalhos:

- **Instrumentação automática**: intercepta chamadas de `express`, `http`, `pg`, `mysql`, `redis` e outras libs criando spans automaticamente
- **API manual**: permite criar seus próprios spans e adicionar contexto de negócio que o Datadog não capturaria sozinho

O ponto crítico é que ela funciona via **monkey-patch** — reescreve funções internas das libs em memória quando é carregada. Por isso precisa ser o **primeiro `require`** do arquivo.

### 4.2 Instalar

```bash
npm install dd-trace
```

### 4.3 Inicializar (primeira linha do app.js)

```js
// DEVE ser o primeiro require — antes de express, http, etc.
const tracer = require('dd-trace').init({
  service: process.env.DD_SERVICE || 'minha-api',
  env: process.env.DD_ENV || 'local',
  version: process.env.DD_VERSION || '1.0.0',
  logInjection: true,    // injeta trace_id nos logs para correlação
  runtimeMetrics: true,  // envia heap, GC e event loop para o APM
});
```

### 4.4 Span manual (operação de banco, chamada externa)

```js
const span = tracer.startSpan('db.query', {
  childOf: tracer.scope().active(), // liga ao span pai atual
  tags: {
    'db.type': 'postgresql',
    'db.statement': 'SELECT * FROM produtos',
  },
});
await minhaOperacao();
span.finish(); // SEMPRE chame finish(), senão o span fica aberto
```

### 4.5 Tag no span ativo (contexto de negócio)

```js
const span = tracer.scope().active();
span.setTag('pedido.id', req.params.id);
span.setTag('usuario.plano', 'premium');
```

### 4.6 Marcar erro no span

```js
span.setTag('error', true);
span.setTag('error.message', err.message);
span.setTag('error.type', err.constructor.name);
span.setTag('error.stack', err.stack);
```

Isso faz o span ficar vermelho no trace explorer e conta na taxa de erro do serviço.

### 4.7 Rebuild e redeploy após mudança no código

```bash
docker build -t minha-api:latest -f k8s/Dockerfile .
k3d image import minha-api:latest --cluster apm-cluster
kubectl rollout restart deployment/minha-api -n minha-api
kubectl rollout status deployment/minha-api -n minha-api
```

### 4.8 Gerar tráfego para popular o APM

```bash
# 100 requisições com concorrência 5
node load-generator.js

# Customizar: 500 requisições com concorrência 10
node load-generator.js 500 10
```

---

## Parte 5 — Ver os traces no Datadog

Após gerar tráfego, acesse `app.datadoghq.com`:

| O que ver | Onde |
|---|---|
| Traces e flame graph | APM → Traces → filtrar `service:minha-api` |
| Latência p50/p95/p99 | APM → Services → minha-api |
| Taxa de erro por rota | APM → Services → minha-api → Errors |
| Métricas de runtime Node.js | APM → Services → Runtime Metrics |
| Mapa de dependências | APM → Service Map |
| Logs correlacionados com traces | Logs → clicar em "View Trace" |

O que observar no flame graph:
- `/relatorio` → span `db.query` com 800ms de latência
- `/pedidos/:id` → cascata de 4 spans filhos
- `/falha` e `/instavel` → spans vermelhos com `error.message` e `error.stack`
- Tags customizadas: `pedido.id`, `produtos.filtro` nos detalhes do span

---

## Parte 6 — Configuração na plataforma (pós-instrumentação)

A instrumentação com `dd-trace` é só a base. O valor real vem da configuração no painel.

### 6.1 Retention Filters

Por padrão o Datadog descarta a maioria dos traces para economizar custo. Você controla o que é retido.

**Onde:** APM → Traces → Retention Filters

Filtros recomendados:
- Reter 100% dos traces com erro: `status:error`
- Reter 100% dos traces lentos (p99): por duração
- Amostrar 10-20% dos traces normais de rotas críticas

### 6.2 Monitors (alertas)

Notifica quando algo quebra — sem monitor, você só descobre o problema quando o cliente reclama.

**Onde:** Monitors → New Monitor → APM

Monitors essenciais para começar:

**Erro rate alto:**
```
Trigger: error rate > 5% por 5 minutos
Serviço: minha-api
Notificar: seu email / Slack
```

**Latência p99 alta:**
```
Trigger: p99 latency > 2s por 5 minutos
Serviço: minha-api
```

**Serviço fora do ar:**
```
Trigger: throughput = 0 por 3 minutos
Serviço: minha-api
```

### 6.3 SLOs (Service Level Objectives)

Define e acompanha metas de qualidade do serviço ao longo do tempo.

**Onde:** SLOs → New SLO → APM

Exemplo:
```
Tipo: APM
Métrica: taxa de sucesso (1 - error rate)
Target: 99.5% em 30 dias
```

O Datadog calcula automaticamente o **error budget** — quanto você ainda pode errar antes de violar o SLO.

### 6.4 Dashboards

Agrupa as métricas mais importantes em uma tela só.

**Onde:** Dashboards → New Dashboard

Widgets úteis para começar:
- Throughput (req/s) por rota
- Error rate por rota
- Latência p50 / p95 / p99
- Runtime metrics: heap used, event loop lag, GC pause

### 6.5 Service Catalog

Documenta o serviço: dono, runbook, repositório, contatos.

**Onde:** APM → Service Catalog → minha-api → Edit

### 6.6 Deployment Tracking

Marca cada deploy no gráfico de métricas para identificar se uma versão nova introduziu regressão.

Funciona automaticamente quando a variável `DD_VERSION` está configurada e muda a cada deploy.

**Onde:** APM → Services → minha-api → Deployments

### 6.7 Log Correlation

Com `logInjection: true` no init do tracer, os logs recebem `trace_id` e `span_id` automaticamente (funciona com Winston e Pino).

No Datadog Logs, você clica em um log e vai direto para o trace correspondente.

**Onde:** Logs → qualquer log do `minha-api` → botão "View Trace"

---

## Rotas disponíveis

| Rota | O que simula |
|---|---|
| `GET /health` | Rota rápida — baseline de latência |
| `GET /produtos?categoria=x` | Tag customizada `produtos.filtro` no span |
| `GET /pedidos/:id` | Múltiplos spans filhos em cascata |
| `GET /relatorio` | Rota lenta (800ms) — aparece no p99 |
| `GET /falha` | Erro controlado — span vermelho sempre |
| `GET /instavel` | ~30% de erro — taxa de erro variável |

---

## Comandos úteis do dia a dia

```bash
# Status geral
kubectl get pods -n datadog
kubectl get pods -n minha-api

# Logs da aplicação
kubectl logs -n minha-api deploy/minha-api -f

# Logs do Datadog Agent
kubectl logs -n datadog -l app.kubernetes.io/component=agent -f

# Rebuild e redeploy completo
docker build -t minha-api:latest -f k8s/Dockerfile . && \
k3d image import minha-api:latest --cluster apm-cluster && \
kubectl rollout restart deployment/minha-api -n minha-api

# Destruir o cluster e recomeçar do zero
k3d cluster delete apm-cluster
```

---

## Referências

- [dd-trace-js no GitHub](https://github.com/DataDog/dd-trace-js)
- [Documentação APM Node.js](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/nodejs/)
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/)
- [Datadog Agent no Kubernetes](https://docs.datadoghq.com/containers/kubernetes/)
- [Monitors APM](https://docs.datadoghq.com/monitors/types/apm/)
- [SLOs](https://docs.datadoghq.com/service_management/service_level_objectives/)
