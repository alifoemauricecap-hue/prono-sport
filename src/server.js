// PRONO SPORT — Serveur principal
// LES DONNÉES D'ABORD. LES MODÈLES ENSUITE. LA DÉCISION EN DERNIER.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { api } from './api/routes.js';
import { bootstrap, startScheduler } from './workers/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// En-têtes de sécurité (§78)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api', api);
// route API inconnue → 404 JSON explicite (jamais avalée par le catch-all SPA)
app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', note: 'Endpoint API inexistant.' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`\n  PRONO SPORT — http://${CONFIG.host}:${CONFIG.port} (${CONFIG.env})`);
  console.log('  Les données d\'abord. Les modèles ensuite. La décision en dernier.\n');
});

// Bootstrap asynchrone : le serveur répond immédiatement, les données arrivent en continu.
bootstrap()
  .then(() => startScheduler())
  .catch((e) => {
    console.error('[PRONO SPORT] Bootstrap partiel :', e.message);
    startScheduler(); // les workers réessaieront (idempotents, §14)
  });

process.on('SIGTERM', () => server.close(() => process.exit(0)));
