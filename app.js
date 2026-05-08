// IMPORTANTE: dd-trace DEVE ser o primeiro require — antes de express, axios, etc.
// Ele faz monkey-patch das libs para capturar spans automaticamente.
require('dotenv').config();

const tracer = require('dd-trace').init({
  service: process.env.DD_SERVICE || 'minha-api',
  env: process.env.DD_ENV || 'local',
  version: process.env.DD_VERSION || '1.0.0',
  logInjection: true,      // injeta trace_id nos logs
  runtimeMetrics: true,    // envia métricas de runtime (heap, GC, event loop)
});

const express = require('express');
const app = express();
app.use(express.json());

// ─── Helpers de simulação ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simula uma query ao banco — cria um span filho chamado "db.query"
async function fakeDbQuery(query, latencyMs) {
  const span = tracer.startSpan('db.query', {
    childOf: tracer.scope().active(),
    tags: {
      'db.type': 'postgresql',
      'db.statement': query,
    },
  });
  await sleep(latencyMs);
  span.finish();
}

// Simula chamada a serviço externo — cria um span filho "http.external"
async function fakeExternalCall(service, latencyMs) {
  const span = tracer.startSpan('http.external', {
    childOf: tracer.scope().active(),
    tags: {
      'peer.service': service,
      'http.method': 'GET',
    },
  });
  await sleep(latencyMs);
  span.finish();
}

// ─── Rotas ───────────────────────────────────────────────────────────────────

// Rota saudável e rápida — boa para baseline de latência
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Rota simples com tag customizada no span ativo
app.get('/produtos', async (req, res) => {
  const span = tracer.scope().active();
  span.setTag('produtos.filtro', req.query.categoria || 'todos');

  await fakeDbQuery('SELECT * FROM produtos WHERE ativo = true', 40);

  res.json({
    produtos: [
      { id: 1, nome: 'Produto A', preco: 99.9 },
      { id: 2, nome: 'Produto B', preco: 149.9 },
    ],
  });
});

// Rota com múltiplos spans filhos — boa para ver cascata no flame graph
app.get('/pedidos/:id', async (req, res) => {
  const span = tracer.scope().active();
  span.setTag('pedido.id', req.params.id);

  // Simula: busca o pedido, depois busca dados do cliente em paralelo com estoque
  await fakeDbQuery(`SELECT * FROM pedidos WHERE id = ${req.params.id}`, 30);
  await Promise.all([
    fakeDbQuery('SELECT * FROM clientes WHERE id = $1', 20),
    fakeDbQuery('SELECT estoque FROM produtos WHERE id = $1', 15),
  ]);
  await fakeExternalCall('servico-pagamento', 60);

  res.json({ id: req.params.id, status: 'aprovado', valor: 299.9 });
});

// Rota lenta — aparece destaque no APM por alta latência (p95/p99)
app.get('/relatorio', async (req, res) => {
  const span = tracer.scope().active();
  span.setTag('relatorio.tipo', 'vendas-mensais');

  await fakeDbQuery('SELECT * FROM vendas GROUP BY mes ORDER BY mes DESC', 800);

  res.json({ relatorio: 'vendas-mensais', linhas: 1240 });
});

// Rota com erro controlado — gera span com error:true no Datadog
app.get('/falha', async (req, res) => {
  const span = tracer.scope().active();

  try {
    await fakeDbQuery('SELECT * FROM tabela_inexistente', 10);
    throw new Error('Tabela não encontrada no banco de dados');
  } catch (err) {
    // Marca o span como erro — aparece vermelho no trace explorer
    span.setTag('error', true);
    span.setTag('error.message', err.message);
    span.setTag('error.type', err.constructor.name);
    span.setTag('error.stack', err.stack);

    res.status(500).json({ erro: err.message });
  }
});

// Rota que falha aleatoriamente ~30% das vezes — boa para ver taxa de erro
app.get('/instavel', async (req, res) => {
  await fakeDbQuery('SELECT * FROM cache', 20);

  if (Math.random() < 0.3) {
    const span = tracer.scope().active();
    const err = new Error('Timeout ao conectar com cache externo');
    span.setTag('error', true);
    span.setTag('error.message', err.message);
    return res.status(503).json({ erro: err.message });
  }

  res.json({ dado: 'valor-do-cache', ttl: 300 });
});

// ─── Servidor ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`DD_SERVICE=${process.env.DD_SERVICE || 'minha-api'} | DD_ENV=${process.env.DD_ENV || 'local'}`);
});
