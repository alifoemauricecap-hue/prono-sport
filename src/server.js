import express from 'express';
import { setupRoutes } from './api/routes.js';
import db from './db.js';
import { startCronJobs } from './engine/cron.js';
import { syncExtraLeagues, syncWorldFixtures, syncLiveMatches } from './engine/sync.js';
import { initCloud, setupCloudSchema, pullFromCloud } from './cloud_sync.js';
import { generatePredictions } from './engine/predictions.js';
import { evaluatePredictions } from './engine/reviews.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

setupRoutes(app);

async function bootstrap() {
  console.log("[BOOTSTRAP] Démarrage du serveur PRONO SPORT...");
  
  // 1. Initialize Cloud Backup
  const cloudEnabled = initCloud();
  if (cloudEnabled) {
    await setupCloudSchema();
    await pullFromCloud(); // Restaure les données précieuses AVANT de tout recalculer
  }

  // 2. Synchronisation initiale si nécessaire
  const counts = db.prepare(`SELECT count(*) as c FROM fixtures`).get();
  if (counts.c < 100) {
      console.log("[BOOTSTRAP] Base de données locale vide, ingestion massive en cours...");
      await syncWorldFixtures(true);
      await syncExtraLeagues();
      console.log("[BOOTSTRAP] Ingestion de base terminée.");
  } else {
      console.log(`[BOOTSTRAP] Base de données locale existante (${counts.c} matchs).`);
  }
  
  // 3. Sync Live & Entraînement/Évaluation
  console.log("[BOOTSTRAP] Mise à jour des matchs du jour...");
  await syncLiveMatches();
  
  console.log("[BOOTSTRAP] Génération des pronostics initiaux et évaluation...");
  await generatePredictions();
  await evaluatePredictions();

  // 4. Lancement des tâches planifiées
  startCronJobs();
  
  app.listen(port, '0.0.0.0', () => {
    console.log(`[BOOTSTRAP] Serveur web prêt sur le port ${port}`);
  });
}

bootstrap().catch(err => {
  console.error("[FATAL] Erreur lors du bootstrap:", err);
  process.exit(1);
});
