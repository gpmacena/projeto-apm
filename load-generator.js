// Gerador de carga para popular o APM com traces variados
// Execute: node load-generator.js

const http = require('http');

const rotas = [
  { path: '/health', peso: 5 },
  { path: '/produtos', peso: 4 },
  { path: '/produtos?categoria=eletronicos', peso: 2 },
  { path: '/pedidos/1', peso: 3 },
  { path: '/pedidos/42', peso: 3 },
  { path: '/relatorio', peso: 1 },   // lenta — usa com moderação
  { path: '/falha', peso: 2 },
  { path: '/instavel', peso: 4 },
];

// Expande rotas pelo peso para sortear proporcionalmente
const pool = rotas.flatMap((r) => Array(r.peso).fill(r.path));

function request(path) {
  return new Promise((resolve) => {
    http
      .get(`http://localhost:3000${path}`, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', resolve); // ignora erros de conexão
  });
}

async function run() {
  const total = parseInt(process.argv[2] || '100');
  const concurrency = parseInt(process.argv[3] || '5');
  let enviadas = 0;
  let erros = 0;

  console.log(`Enviando ${total} requisições com concorrência ${concurrency}...`);

  async function worker() {
    while (enviadas < total) {
      const path = pool[Math.floor(Math.random() * pool.length)];
      enviadas++;
      const n = enviadas;
      process.stdout.write(`\r${n}/${total}`);
      await request(path);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`\nPronto. ${total} requisições enviadas.`);
}

run();
