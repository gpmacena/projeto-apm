# Datadog APM — Guia de Instrumentação Node.js

Aplicação de estudo para aprender instrumentação com Datadog APM.  
Objetivo: entender traces, spans, métricas de runtime e correlação de logs antes de aplicar em ambiente com cluster.

---

## Estrutura do projeto

```
aplication-apm/
├── app.js              # Aplicação Express instrumentada
├── load-generator.js   # Gerador de carga para popular o APM
├── package.json
└── .env.example        # Variáveis de ambiente necessárias
```

---

## Como o Datadog APM funciona (conceitos)

```
Requisição HTTP
     │
     ▼
┌─────────────────────────────────────────┐
│  TRACE  (representa toda a requisição)  │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  SPAN raiz: express.request      │   │  ← criado automaticamente pelo dd-trace
│  │  tags: http.method, http.url...  │   │
│  │                                  │   │
│  │  ┌────────────────────────────┐  │   │
│  │  │  SPAN filho: db.query      │  │   │  ← criado manualmente ou auto (pg, mysql)
│  │  │  tags: db.statement...     │  │   │
│  │  └────────────────────────────┘  │   │
│  │                                  │   │
│  │  ┌────────────────────────────┐  │   │
│  │  │  SPAN filho: http.external │  │   │
│  │  └────────────────────────────┘  │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
         │
         ▼
   Datadog Agent (porta 8126)
         │
         ▼
   Datadog Backend (app.datadoghq.com)
```

**Trace** = jornada completa de uma requisição (tem um `trace_id`).  
**Span** = uma operação dentro do trace (tem `span_id` e `parent_id`).  
**Tag** = metadado chave:valor em qualquer span (ex: `pedido.id=42`).

---

## Pré-requisitos

- Node.js 18+
- Docker (para rodar o Datadog Agent localmente)
- Conta no Datadog com API Key

---

## 1. Subir o Datadog Agent localmente

O Agent recebe os traces da sua aplicação e os envia ao backend do Datadog.

```bash
docker run -d \
  --name datadog-agent \
  -e DD_API_KEY=<SUA_API_KEY> \
  -e DD_APM_ENABLED=true \
  -e DD_APM_NON_LOCAL_TRAFFIC=true \
  -e DD_LOGS_ENABLED=true \
  -e DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL=true \
  -p 8126:8126/tcp \
  -p 8125:8125/udp \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /proc/:/host/proc/:ro \
  -v /sys/fs/cgroup/:/host/sys/fs/cgroup:ro \
  gcr.io/datadoghq/agent:latest
```

Verificar se o Agent está aceitando traces:
```bash
curl http://localhost:8126/info
```

Deve retornar um JSON com versão e configurações do Agent.

---

## 2. Instalar dependências

```bash
npm install
cp .env.example .env
# Edite o .env com sua configuração
```

---

## 3. Configurar variáveis de ambiente

Edite o `.env`:

```env
DD_AGENT_HOST=localhost
DD_TRACE_AGENT_PORT=8126

# Nome do serviço — aparece no Service Catalog do Datadog
DD_SERVICE=minha-api

# Ambiente — separa prod/staging/local no APM
DD_ENV=local

# Versão — permite comparar deployments no Deployment Tracking
DD_VERSION=1.0.0

DD_TRACE_ENABLED=true
DD_LOGS_INJECTION=true
```

> **Por que DD_SERVICE importa?** No Datadog, o `service` é a unidade principal de agrupamento.
> Tudo que você vê no APM (latência p99, taxa de erro, throughput) é por serviço.

---

## 4. Iniciar a aplicação

```bash
npm start
```

Saída esperada:
```
Servidor rodando em http://localhost:3000
DD_SERVICE=minha-api | DD_ENV=local
```

---

## 5. Gerar tráfego para o APM

```bash
# Envia 100 requisições com concorrência 5 (padrão)
npm run load

# Customizar: 500 requisições com concorrência 10
node load-generator.js 500 10
```

Ou manualmente com curl:

```bash
# Rota saudável
curl http://localhost:3000/health

# Rota com parâmetro (tag customizada no span)
curl http://localhost:3000/produtos?categoria=eletronicos

# Rota com múltiplos spans filhos (cascata no flame graph)
curl http://localhost:3000/pedidos/1

# Rota lenta (alta latência)
curl http://localhost:3000/relatorio

# Rota que sempre falha (gera span com error:true)
curl http://localhost:3000/falha

# Rota instável (~30% de erro)
curl http://localhost:3000/instavel
```

---

## 6. Ver os traces no Datadog

1. Acesse: **APM → Traces** em `app.datadoghq.com`
2. Filtre por `service:minha-api` e `env:local`
3. Clique em qualquer trace para ver o **flame graph**

O que observar:
- **Flame graph**: cascata de spans, duração de cada um
- **Span mais lento**: `/relatorio` → span `db.query` com 800ms
- **Spans com erro**: `/falha` e `/instavel` → marcados em vermelho
- **Tags customizadas**: `pedido.id`, `produtos.filtro` aparecem nos detalhes do span

---

## 7. Conceitos de instrumentação que esta app demonstra

### 7.1 Inicialização do tracer (crítico)

```js
// app.js — linha 1, ANTES de qualquer outro require
const tracer = require('dd-trace').init({ ... });
```

Se `dd-trace` for inicializado depois do `express`, ele não consegue fazer
o monkey-patch e as rotas não aparecem como spans automáticos.

### 7.2 Span manual (span filho)

```js
const span = tracer.startSpan('db.query', {
  childOf: tracer.scope().active(), // liga ao span pai atual
  tags: {
    'db.type': 'postgresql',
    'db.statement': 'SELECT ...',
  },
});
await minhaQuery();
span.finish(); // SEMPRE chame finish(), senão o span fica aberto
```

### 7.3 Tags no span ativo

```js
const span = tracer.scope().active();
span.setTag('pedido.id', req.params.id);
```

Útil para adicionar contexto de negócio sem criar um span novo.

### 7.4 Marcar erro no span

```js
span.setTag('error', true);
span.setTag('error.message', err.message);
span.setTag('error.type', err.constructor.name);
span.setTag('error.stack', err.stack);
```

Isso faz o span ficar vermelho no trace explorer e conta na taxa de erro do serviço.

### 7.5 Correlação de logs com traces

Com `DD_LOGS_INJECTION=true` e `logInjection: true` no init, o `dd-trace`
injeta automaticamente `trace_id` e `span_id` nos logs (funciona com Winston e Pino).

No Datadog Logs, você pode clicar em "Ver trace" direto do log.

---

## 8. Aplicando em ambiente com cluster (próximo passo)

### Kubernetes com Datadog Agent como DaemonSet

No cluster, o Agent roda como DaemonSet — um pod por nó.
Sua aplicação precisa saber o IP do nó para enviar traces.

```yaml
# deployment.yaml — adicionar nas variáveis de ambiente do container
env:
  - name: DD_AGENT_HOST
    valueFrom:
      fieldRef:
        fieldPath: status.hostIP   # IP do nó onde o pod está rodando
  - name: DD_TRACE_AGENT_PORT
    value: "8126"
  - name: DD_SERVICE
    value: "minha-api"
  - name: DD_ENV
    value: "production"
  - name: DD_VERSION
    valueFrom:
      fieldRef:
        fieldPath: metadata.labels['tags.datadoghq.com/version']
```

### Unified Service Tagging (recomendado em cluster)

O Datadog recomenda usar labels no pod para correlacionar métricas + traces + logs:

```yaml
# deployment.yaml — labels no pod
labels:
  tags.datadoghq.com/service: "minha-api"
  tags.datadoghq.com/env: "production"
  tags.datadoghq.com/version: "1.0.0"
```

Com isso, o Agent lê as labels e injeta as tags automaticamente — você não precisa
de variáveis de ambiente separadas.

### Helm Chart do Datadog Agent

```bash
helm repo add datadog https://helm.datadoghq.com
helm install datadog-agent datadog/datadog \
  --set datadog.apiKey=<SUA_API_KEY> \
  --set datadog.apm.portEnabled=true \
  --set datadog.logs.enabled=true \
  --set datadog.logs.containerCollectAll=true
```

---

## 9. O que monitorar no APM depois de instrumentado

| O que ver | Onde no Datadog |
|---|---|
| Latência p50/p95/p99 por rota | APM → Services → minha-api |
| Taxa de erro por rota | APM → Services → minha-api → Errors |
| Trace mais lento da última hora | APM → Traces → filtrar por duração |
| Memória heap e GC do Node.js | APM → Services → Runtime Metrics |
| Dependências entre serviços | APM → Service Map |
| Correlação log ↔ trace | Logs → clicar em "View Trace" |

---

## Referências

- [dd-trace-js no GitHub](https://github.com/DataDog/dd-trace-js)
- [Documentação APM Node.js](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/nodejs/)
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/)
- [Datadog Agent no Kubernetes](https://docs.datadoghq.com/containers/kubernetes/)
# projeto-apm
