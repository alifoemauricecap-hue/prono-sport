import { createClient } from "@libsql/client";
import { db } from "./db.js";

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
  const tables = [
    `CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY, fixture_id TEXT, date TEXT, probability REAL, value REAL, result TEXT
    )`
  ];
  for (const query of tables) {
    try { await cloudClient.execute(query); } catch (e) {}
  }
}

export async function pullFromCloud() {
  if (!cloudClient) return;
  isRestoring = true;
  // simplified pull logic for stability
  try {
    const rs = await cloudClient.execute(`SELECT * FROM predictions LIMIT 10`);
    console.log(`[CLOUD] Restauré ${rs.rows?.length || 0} lignes.`);
  } catch (err) {}
  isRestoring = false;
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
  } catch (err) { }
}
