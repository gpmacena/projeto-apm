require('dotenv').config();

const express = require('express');
const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeDbQuery(query, latencyMs) {
  await sleep(latencyMs);
}

async function fakeExternalCall(service, latencyMs) {
  await sleep(latencyMs);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/produtos', async (req, res) => {
  await fakeDbQuery('SELECT * FROM produtos WHERE ativo = true', 40);

  res.json({
    produtos: [
      { id: 1, nome: 'Produto A', preco: 99.9 },
      { id: 2, nome: 'Produto B', preco: 149.9 },
    ],
  });
});

app.get('/pedidos/:id', async (req, res) => {
  await fakeDbQuery(`SELECT * FROM pedidos WHERE id = ${req.params.id}`, 30);
  await Promise.all([
    fakeDbQuery('SELECT * FROM clientes WHERE id = $1', 20),
    fakeDbQuery('SELECT estoque FROM produtos WHERE id = $1', 15),
  ]);
  await fakeExternalCall('servico-pagamento', 60);

  res.json({ id: req.params.id, status: 'aprovado', valor: 299.9 });
});

app.get('/relatorio', async (req, res) => {
  await fakeDbQuery('SELECT * FROM vendas GROUP BY mes ORDER BY mes DESC', 800);

  res.json({ relatorio: 'vendas-mensais', linhas: 1240 });
});

app.get('/falha', async (req, res) => {
  try {
    await fakeDbQuery('SELECT * FROM tabela_inexistente', 10);
    throw new Error('Tabela não encontrada no banco de dados');
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/instavel', async (req, res) => {
  await fakeDbQuery('SELECT * FROM cache', 20);

  if (Math.random() < 0.3) {
    return res.status(503).json({ erro: 'Timeout ao conectar com cache externo' });
  }

  res.json({ dado: 'valor-do-cache', ttl: 300 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
