// dd-trace DEVE ser o primeiro require
require('dotenv').config();

const tracer = require('dd-trace').init({
  service: process.env.DD_SERVICE || 'minha-api',
  env: process.env.DD_ENV || 'local',
  version: process.env.DD_VERSION || '1.0.0',
  logInjection: true,
  runtimeMetrics: true,
});

const express = require('express');
const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function fakeExternalCall(service, latencyMs) {
  const span = tracer.startSpan('http.external', {
    childOf: tracer.scope().active(),
    tags: { 'peer.service': service },
  });
  await sleep(latencyMs);
  span.finish();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

app.get('/pedidos/:id', async (req, res) => {
  const span = tracer.scope().active();
  span.setTag('pedido.id', req.params.id);

  await fakeDbQuery(`SELECT * FROM pedidos WHERE id = ${req.params.id}`, 30);
  await Promise.all([
    fakeDbQuery('SELECT * FROM clientes WHERE id = $1', 20),
    fakeDbQuery('SELECT estoque FROM produtos WHERE id = $1', 15),
  ]);
  await fakeExternalCall('servico-pagamento', 60);

  res.json({ id: req.params.id, status: 'aprovado', valor: 299.9 });
});

app.get('/relatorio', async (req, res) => {
  const span = tracer.scope().active();
  span.setTag('relatorio.tipo', 'vendas-mensais');

  await fakeDbQuery('SELECT * FROM vendas GROUP BY mes ORDER BY mes DESC', 800);

  res.json({ relatorio: 'vendas-mensais', linhas: 1240 });
});

app.get('/falha', async (req, res) => {
  const span = tracer.scope().active();
  try {
    await fakeDbQuery('SELECT * FROM tabela_inexistente', 10);
    throw new Error('Tabela não encontrada no banco de dados');
  } catch (err) {
    span.setTag('error', true);
    span.setTag('error.message', err.message);
    span.setTag('error.type', err.constructor.name);
    span.setTag('error.stack', err.stack);
    res.status(500).json({ erro: err.message });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
