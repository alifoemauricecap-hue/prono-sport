import { createClient } from "@libsql/client";
import db from "./db.js";

let cloudClient = null;
let isRestoring = false;

export function initCloud() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.log("[CLOUD] Variables TURSO manquantes. Sync désactivée.");
    return false;
  }
  
  try {
    cloudClient = createClient({ url, authToken });
    console.log("[CLOUD] Client Turso initialisé avec succès !");
    return true;
  } catch(err) {
    console.error("[CLOUD] Erreur init client Turso:", err.message);
    return false;
  }
}

export async function setupCloudSchema() {
  if (!cloudClient) return;
  console.log("[CLOUD] Vérification du schéma distant...");
  
  const tables = [
    `CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY, fixture_id INTEGER, prediction_type TEXT, 
        prediction_value TEXT, probability REAL, odds REAL, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS daily_selections (
        id TEXT PRIMARY KEY, date TEXT, selection_type TEXT, 
        fixtures_json TEXT, total_odds REAL, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS prediction_reviews (
        id TEXT PRIMARY KEY, prediction_id TEXT, fixture_id INTEGER, 
        status TEXT, actual_result TEXT, brier_score REAL, profit REAL, reviewed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS model_versions (
        version TEXT PRIMARY KEY, trained_at TEXT, features_json TEXT, 
        weights_json TEXT, metrics_json TEXT, calibration_json TEXT, value_json TEXT
    )`
  ];
  
  for (const query of tables) {
    try {
      await cloudClient.execute(query);
    } catch (err) {
      console.error("[CLOUD] Erreur création table:", err.message);
    }
  }
  console.log("[CLOUD] Schéma distant OK.");
}

export async function pullFromCloud() {
  if (!cloudClient) return;
  isRestoring = true;
  console.log("[CLOUD] Début de la restauration depuis Turso...");
  
  const tablesToPull = ['model_versions', 'predictions', 'prediction_reviews', 'daily_selections'];
  let totalRestored = 0;

  for (const table of tablesToPull) {
    try {
      const rs = await cloudClient.execute(`SELECT * FROM ${table}`);
      if (!rs.rows || rs.rows.length === 0) continue;
      
      const columns = Object.keys(rs.rows[0]);
      const placeholders = columns.map(() => '?').join(', ');
      
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
      const insertMany = db.transaction((rows) => {
        for (const row of rows) {
          const values = columns.map(col => row[col]);
          stmt.run(...values);
        }
      });
      
      insertMany(rs.rows);
      console.log(`[CLOUD] Restauré ${rs.rows.length} lignes dans ${table}.`);
      totalRestored += rs.rows.length;
    } catch (err) {
      console.error(`[CLOUD] Erreur restauration table ${table} :`, err.message);
    }
  }
  
  isRestoring = false;
  console.log(`[CLOUD] Restauration terminée. Total: ${totalRestored} lignes.`);
}

export async function pushToCloud(table, rowData) {
  if (!cloudClient || isRestoring) return;
  
  try {
    const columns = Object.keys(rowData);
    const values = Object.values(rowData);
    const placeholders = columns.map(() => '?').join(', ');
    
    await cloudClient.execute({
      sql: `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      args: values
    });
  } catch (err) {
    console.error(`[CLOUD] Erreur push vers ${table} :`, err.message);
  }
}
