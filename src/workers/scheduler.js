// PRONO SPORT — Workers de synchronisation (§14) + LIVE ENGINE (§15) + FAILOVER (§64)
// Chaque worker est idempotent (upserts), réessayable, journalisé (sync_jobs) et monitoré.
// Ordre de priorité §10 : LIVE > imminents > à venir > cotes > historique > découverte.
import { db, now, logJob, notify } from '../db.js';
import { CONFIG } from '../config.js';
import { registerSources, checkSourceHealth } from '../providers/registry.js';
import * as fdcuk from '../providers/footballDataCoUk.js';
import * as tsdb from '../providers/theSportsDb.js';
import * as oligadb from '../providers/openLigaDb.js';
import { generatePrediction, settlePredictions } from '../engine/predictions.js';
import { updateLivePredictions } from '../engine/live.js';
import * as espn from '../providers/espn.js';
import { runDeepResearch } from '../engine/research.js';
import { ensureDailySelections, lockAndSettleSelections, computeLessons, todayUtc } from '../engine/daily.js';
import { generatePendingReviews } from '../engine/review.js';

export const liveEvents = { listeners: new Set() };
export function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of liveEvents.listeners) { try { res.write(msg); } catch { /* client parti */ } }
}

async function runJob(name, sourceId, fn) {
  const job = logJob(name, sourceId);
  try {
    const items = await fn();
    job.finish('COMPLETED', typeof items === 'number' ? items : (items?.total ?? 0),
      items?.errors?.length ? items.errors.join('; ') : null);
    return items;
  } catch (e) {
    job.finish('FAILED', 0, e.message);
    return null;
  }
}

/** P1 — LIVE ENGINE : détection et synchro des matchs en direct */
export async function syncLiveMatches() {
  let totalLive = 0;
  for (const shortcut of Object.keys(oligadb.OPENLIGA_LEAGUES)) {
    const r = await runJob('syncLiveMatches', 'openligadb', () => oligadb.syncCurrentMatchday(shortcut));
    if (r?.liveCount) totalLive += r.liveCount;
  }
  // transitions de statut basées sur l'horloge pour matchs sans source live :
  // SCHEDULED → UPCOMING (< 2h) ; jamais marqués LIVE sans confirmation (§12)
  db.prepare(`UPDATE fixtures SET status='UPCOMING'
      WHERE status='SCHEDULED' AND kickoff_utc BETWEEN datetime('now') AND datetime('now', '+2 hours')`).run();
  // coup d'envoi passé sans confirmation de source live → UNKNOWN, pas LIVE
  db.prepare(`UPDATE fixtures SET status='UNKNOWN'
      WHERE status IN ('SCHEDULED','UPCOMING') AND kickoff_utc < datetime('now', '-10 minutes')
      AND home_score IS NULL`).run();
  // LIVE PREDICTION ENGINE (§53) : recalcul minute par minute des matchs confirmés live
  const liveSnaps = updateLivePredictions();
  if (liveSnaps) broadcast('live_prediction', { snapshots: liveSnaps, at: now() });
  if (totalLive) broadcast('live_update', { liveCount: totalLive, at: now() });
  return totalLive;
}

/** P2/P3 — matchs à venir + cotes réelles, avec failover multi-sources (§64) */
export async function syncFixtures() {
  let ok = false;
  const r1 = await runJob('syncFixtures', 'football-data-couk', () => fdcuk.syncUpcomingFixtures());
  if (r1 != null) ok = true;
  // validation croisée / enrichissement logos & stades — source secondaire
  for (const divCode of Object.keys(CONFIG.divisions)) {
    await runJob('syncFixtures.tsdb', 'thesportsdb', () => tsdb.syncLeagueUpcoming(divCode));
  }
  if (!ok) notify('SOURCE_DOWN', { source: 'football-data-couk', fallback: 'thesportsdb', at: now() });
  return ok;
}

/** Résultats récents + settlement des pronostics (§17) */
export async function syncResults() {
  await runJob('syncResults', 'football-data-couk', () => fdcuk.syncRecentResults());
  for (const divCode of Object.keys(CONFIG.divisions)) {
    await runJob('syncResults.tsdb', 'thesportsdb', () => tsdb.syncLeaguePast(divCode));
  }
  const settled = settlePredictions();
  if (settled) broadcast('predictions_settled', { settled, at: now() });
  return settled;
}

/** P7 — Historique complet (HistoricalDataProvider) */
export async function syncHistoricalData() {
  let total = 0;
  const errors = [];
  for (const season of CONFIG.historicalSeasons) {
    for (const divCode of Object.keys(CONFIG.divisions)) {
      try {
        total += await fdcuk.syncHistoricalSeason(season.trim(), divCode);
      } catch (e) { errors.push(`${season}/${divCode}: ${e.message}`); }
    }
  }
  const job = logJob('syncHistoricalData', 'football-data-couk');
  job.finish(errors.length ? 'PARTIAL' : 'COMPLETED', total, errors.slice(0, 5).join('; '));
  return { total, errors };
}

/** Historique Bundesliga OpenLigaDB (validation croisée D1/D2) */
export async function syncOpenLigaHistory() {
  const years = [2023, 2024, 2025];
  let total = 0;
  for (const shortcut of Object.keys(oligadb.OPENLIGA_LEAGUES)) {
    for (const y of years) {
      const n = await runJob('syncHistoricalData.openligadb', 'openligadb', () => oligadb.syncSeason(shortcut, y));
      if (n) total += n;
    }
  }
  return total;
}

/** Génère les pronostics pour tous les matchs à venir analysables */
export async function generateUpcomingPredictions() {
  const upcoming = db.prepare(`SELECT id FROM fixtures
      WHERE status IN ('SCHEDULED','UPCOMING') AND kickoff_utc > datetime('now')
      AND kickoff_utc < datetime('now', '+10 days') ORDER BY kickoff_utc ASC LIMIT 300`).all();
  const job = logJob('generatePredictions', null);
  let n = 0;
  for (const f of upcoming) {
    try { if (generatePrediction(f.id).status === 'OK') n++; } catch { /* compté dans errors */ }
    // petites instances : VRAIE pause entre analyses (healthcheck <1 s garanti)
    await new Promise((r) => setTimeout(r, 15));
  }
  job.finish('COMPLETED', n, null);
  return n;
}

/** Ligues mondiales : historique /new/ + fixtures cotées (football-data.co.uk) */
export async function syncWorldData() {
  const missing = Object.entries(CONFIG.extraLeagues || {}).filter(([code, meta]) =>
    meta.file && !db.prepare(`SELECT 1 FROM competitions WHERE code=?`).get(code));
  let total = 0;
  if (missing.length) {
    const r = await runJob('syncExtraLeagues', 'football-data-couk', () => fdcuk.syncExtraLeagues());
    total = r?.total || 0;
  } else {
    // rafraîchissement : seules les ligues avec matchs récents à re-lire
    for (const code of Object.keys(CONFIG.extraLeagues || {})) {
      const n = await runJob(`syncExtraLeague.${code}`, 'football-data-couk', () => fdcuk.syncExtraLeague(code));
      if (n) total += n;
    }
  }
  const fx = await runJob('syncWorldFixtures', 'football-data-couk', () => fdcuk.syncWorldFixtures());
  return { total, fixtures: fx || 0 };
}

/** Découverte autonome + synchro des ligues découvertes */
export async function runDiscoveryCycle() {
  const d = await runJob('discoverWorldLeagues', 'thesportsdb', () => tsdb.discoverWorldLeagues());
  const s = await runJob('syncDiscoveredLeagues', 'thesportsdb', () => tsdb.syncDiscoveredLeagues());
  return { discovery: d, sync: s };
}

/** Checkpoint WAL : fusionne le journal dans le fichier principal (durabilité).
 *  PASSIVE (incrémental, non bloquant pour les écrivains) et JAMAIS pendant une
 *  ingestion massive : un TRUNCATE synchrone à 0,1 CPU gelait l'event loop
 *  plusieurs secondes → healthcheck en échec → redémarrage (mesuré en prod). */
let ingestionBusy = 0;
export function checkpointWal() {
  if (ingestionBusy > 0) return; // l'autocheckpoint SQLite (incrémental) suffit pendant l'ingestion
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* base occupée : au prochain cycle */ }
}

/** Bootstrap complet au premier démarrage (base vide) */
export async function bootstrap() {
  ingestionBusy++;
  try {
    return await bootstrapInner();
  } finally {
    ingestionBusy--;
  }
}

async function bootstrapInner() {
  registerSources();
  const fixturesCount = db.prepare(`SELECT COUNT(*) AS n FROM fixtures`).get().n;
  console.log(`[PRONO SPORT] Base : ${fixturesCount} matchs.`);
  await checkSourceHealth();
  if (fixturesCount < 500) {
    console.log('[PRONO SPORT] Chargement initial de l\'historique réel (football-data.co.uk)…');
    const h = await syncHistoricalData();
    console.log(`[PRONO SPORT] Historique : ${h.total} matchs ingérés (${h.errors.length} erreurs source).`);
    await syncOpenLigaHistory();
  }
  // Couverture mondiale : ingérée si absente (ligues /new/ + fixtures cotées)
  const worldMissing = Object.entries(CONFIG.extraLeagues || {}).some(([code, meta]) =>
    meta.file && !db.prepare(`SELECT 1 FROM competitions WHERE code=?`).get(code));
  if (worldMissing) {
    console.log('[PRONO SPORT] Chargement des ligues mondiales (football-data.co.uk /new/)…');
    const w = await syncWorldData();
    console.log(`[PRONO SPORT] Monde : ${w.total} matchs + ${w.fixtures} fixtures cotées.`);
  } else {
    await runJob('syncWorldFixtures', 'football-data-couk', () => fdcuk.syncWorldFixtures());
  }
  // Couverture élargie ESPN : 33 compétitions, 2 années civiles chacune
  // (dont Saudi Pro League, A-League, UCL, UEL, Libertadores — sans CSV)
  const espnMissing = Object.keys(espn.espnComps()).filter((code) =>
    !db.prepare(`SELECT 1 FROM competitions WHERE code=?`).get(code));
  if (espnMissing.length) {
    console.log(`[PRONO SPORT] Couverture élargie ESPN (${espnMissing.length} compétitions à créer)…`);
    const e = await runJob('syncEspnHistory', 'espn', () => espn.syncEspnHistory());
    console.log(`[PRONO SPORT] ESPN : ${e?.total ?? 0} matchs ingérés (${e?.errors?.length ?? 0} erreurs source).`);
  }
  await syncFixtures();
  await syncResults();
  await syncLiveMatches();
  checkpointWal();
  // COTES ESPN (§v3.3) : déblocage du Value Engine pour les matchs des 72 h
  // sans cotes CSV (Saudi, Japon, MLS…) — cotes bookmaker réelles (pickcenter)
  try {
    const eo = await runJob('syncEspnOdds', 'espn', () => espn.syncEspnOdds(72, 60));
    console.log(`[PRONO SPORT] Cotes ESPN : ${eo?.found ?? 0}/${eo?.scanned ?? 0} matchs cotés.`);
  } catch (e) { console.error('[PRONO SPORT] Cotes ESPN :', e.message); }
  const preds = await generateUpcomingPredictions();
  console.log(`[PRONO SPORT] ${preds} analyses générées pour les matchs à venir.`);
  // Sélections du jour + jour courant + première passe de logos (ciblée, polie)
  db.prepare(`INSERT INTO kv (key, value) VALUES ('current_day', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(todayUtc());
  ensureDailySelections();
  try {
    await tsdb.backfillCompetitionLogos(8);
    await tsdb.backfillTeamBadges(10);
  } catch { /* repris par le worker logoBackfill */ }
  checkpointWal();
  // Découverte autonome DIFFÉRÉE (75 s après le boot : priorité aux données
  // critiques, respect du rate limit de la source de découverte)
  const t = setTimeout(async () => {
    try {
      const r = await runDiscoveryCycle();
      console.log(`[PRONO SPORT] Découverte : ${r.discovery?.tested ?? 0} testées, ${r.discovery?.approved ?? 0} approuvées, ${r.discovery?.rejected ?? 0} rejetées ; ${r.sync?.events ?? 0} événements synchronisés.`);
      await generateUpcomingPredictions();
      checkpointWal();
    } catch (e) { console.error('[PRONO SPORT] découverte :', e.message); }
  }, 75_000);
  t.unref?.();
}

let timers = [];

// FILE D'EXCLUSION MUTUELLE : sur petite instance (0,1 CPU), deux gros
// travaux simultanés étouffent le processeur → healthcheck en échec →
// redémarrage par l'hébergeur (mesuré en prod). Les travaux lourds passent
// donc un par un ; les légers (live, checkpoint) restent immédiats.
let heavyChain = Promise.resolve();
function runExclusive(fn) {
  const p = heavyChain.then(() => fn());
  heavyChain = p.catch(() => {}); // une erreur ne bloque jamais la file
  return p;
}

export function startScheduler() {
  // offset : premier déclenchement décalé pour désynchroniser les robots.
  // Sans cela, tous les intervalles divisant 60 min, les 14 robots partaient
  // EN MÊME TEMPS aux minutes 60, 120, 180… (pic CPU fatal à 0,1 CPU).
  const schedule = (fn, ms, name, { offset = 0, exclusive = true } = {}) => {
    const run = () => (exclusive ? runExclusive(fn) : fn())
      .catch((e) => console.error(`[worker ${name}]`, e.message));
    const start = () => { const t = setInterval(run, ms); t.unref?.(); timers.push(t); };
    if (offset > 0) {
      const t0 = setTimeout(() => { run(); start(); }, offset);
      t0.unref?.();
      timers.push(t0);
    } else start();
  };
  const S = 1000, MIN = 60 * 1000;
  // live : léger et prioritaire → jamais dans la file exclusive, jamais décalé
  schedule(syncLiveMatches, CONFIG.syncIntervals.live, 'live', { exclusive: false });
  schedule(syncFixtures, CONFIG.syncIntervals.upcoming, 'fixtures', { offset: 3 * MIN });
  schedule(syncResults, CONFIG.syncIntervals.results, 'results', { offset: 7 * MIN });
  schedule(async () => { await syncHistoricalData(); await syncOpenLigaHistory(); }, CONFIG.syncIntervals.historical, 'historical', { offset: 45 * MIN });
  schedule(async () => checkSourceHealth(), CONFIG.syncIntervals.discovery, 'discovery', { offset: 50 * MIN });
  schedule(generateUpcomingPredictions, 30 * 60 * 1000, 'predictions', { offset: 18 * MIN });
  // monde : fixtures cotées + ligues dynamiques découvertes
  schedule(async () => { await runJob('syncWorldFixtures', 'football-data-couk', () => fdcuk.syncWorldFixtures()); }, 20 * 60 * 1000, 'worldFixtures', { offset: 11 * MIN });
  schedule(async () => { await runJob('syncDiscoveredLeagues', 'thesportsdb', () => tsdb.syncDiscoveredLeagues()); }, 20 * 60 * 1000, 'dynamicLeagues', { offset: 13 * MIN });
  // retest des candidats PENDING (rate-limités) toutes les 12 min
  schedule(async () => {
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM discovered_leagues WHERE status='PENDING'`).get().n;
    if (pending > 0) await runJob('discoveryRetry', 'thesportsdb', () => tsdb.processDiscoveryBatch());
  }, 12 * 60 * 1000, 'discoveryRetry', { offset: 6 * MIN });
  // cycle de découverte complet toutes les 6 h
  schedule(runDiscoveryCycle, 6 * 60 * 60 * 1000, 'discoveryFull', { offset: 55 * MIN });
  // SUIVI DU JOUR ESPN (ciblé) : scores/statuts des ligues jouant aujourd'hui
  schedule(async () => {
    const r = await runJob('syncEspnToday', 'espn', () => espn.syncEspnToday());
    if (r?.total) await updateLivePredictions(broadcast);
  }, 5 * 60 * 1000, 'espnToday', { offset: 45 * S });
  // COTES ESPN (§v3.3) : matchs à venir sans cotes → pickcenter bookmaker,
  // puis régénération des analyses débloquées
  schedule(async () => {
    const r = await runJob('syncEspnOdds', 'espn', () => espn.syncEspnOdds(72, 30));
    if (r?.found) await generateUpcomingPredictions();
  }, 20 * 60 * 1000, 'espnOdds', { offset: 9 * MIN + 30 * S });
  // DEEP RESEARCH ENGINE : recherche en ligne ciblée pour chaque match à venir
  // qui manque de données (historique équipe/compétition), puis régénération
  schedule(async () => {
    const r = await runDeepResearch();
    if (r?.regenerated) broadcast('research', { gaps: r.gaps, regenerated: r.regenerated });
  }, 15 * 60 * 1000, 'deepResearch', { offset: 8 * MIN + 30 * S });
  // SÉLECTIONS DU JOUR : Expert + Combiné Safe (création/verrouillage/règlement)
  schedule(async () => {
    ensureDailySelections();
    const r = lockAndSettleSelections();
    if (r.settled) broadcast('selections', r);
  }, 10 * 60 * 1000, 'dailySelections', { offset: 4 * MIN });
  // COMPTES RENDUS POST-MATCH : recherche ciblée + rédaction factuelle
  schedule(async () => {
    const n = await runJob('postMatchReviews', null, () => generatePendingReviews());
    if (n) broadcast('reviews', { created: n });
  }, 10 * 60 * 1000, 'postMatchReviews', { offset: 5 * MIN });
  // LOGOS : équipes des matchs des 72 h + compétitions — recherche ciblée polie
  schedule(async () => {
    await runJob('logoBackfill', 'thesportsdb', async () => {
      const a = await tsdb.backfillTeamBadges(15);
      const b = await tsdb.backfillCompetitionLogos(8);
      return a.found + b.found;
    });
  }, 60 * 60 * 1000, 'logoBackfill', { offset: 22 * MIN });
  // BASCULE DE JOUR : au changement de date UTC, rafraîchir les matchs du
  // nouveau jour, relancer recherches + analyses + sélections + leçons
  schedule(async () => {
    const day = todayUtc();
    const prev = db.prepare(`SELECT value FROM kv WHERE key='current_day'`).get()?.value;
    if (prev === day) return;
    db.prepare(`INSERT INTO kv (key, value) VALUES ('current_day', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(day);
    if (!prev) return; // premier boot : bootstrap s'en charge
    console.log(`[PRONO SPORT] Nouveau jour ${day} : synchro + analyses des matchs du jour…`);
    await syncFixtures();
    await runJob('syncEspnToday', 'espn', () => espn.syncEspnToday());
    await runDeepResearch();
    await generateUpcomingPredictions();
    ensureDailySelections(day);
    computeLessons(); // leçons recalculées chaque jour sur les résultats réels
    broadcast('newday', { day });
  }, 5 * 60 * 1000, 'dayRollover', { offset: 2 * MIN + 10 * S });
  // RATTRAPAGE AUTONOME : si le chargement initial a été gêné par la source
  // (rate limit hébergeur), on complète progressivement — jamais de données
  // manquantes définitives tant que la source redevient joignable.
  schedule(async () => {
    const missingCsv = Object.entries(CONFIG.extraLeagues || {}).filter(([code, meta]) =>
      meta.file && !db.prepare(`SELECT 1 FROM competitions WHERE code=?`).get(code));
    if (missingCsv.length) {
      console.log(`[PRONO SPORT] Rattrapage monde : ${missingCsv.length} ligue(s) CSV manquante(s).`);
      await syncWorldData();
    }
    const missingEspn = Object.keys(espn.espnComps()).filter((code) =>
      !db.prepare(`SELECT 1 FROM competitions WHERE code=?`).get(code));
    if (missingEspn.length) {
      console.log(`[PRONO SPORT] Rattrapage ESPN : ${missingEspn.length} compétition(s) manquante(s).`);
      await runJob('syncEspnHistory', 'espn', () => espn.syncEspnHistory());
    }
    const finished = db.prepare(`SELECT COUNT(*) AS n FROM fixtures WHERE status='FINISHED'`).get().n;
    // Europe seule ≈ 16 500 matchs sur 3 saisons : en dessous de 15 000,
    // l'historique est manifestement incomplet → nouvelle passe
    if (finished < 15000) {
      console.log(`[PRONO SPORT] Rattrapage historique (${finished} matchs terminés en base).`);
      await syncHistoricalData();
      await syncOpenLigaHistory();
      await generateUpcomingPredictions();
    }
  }, 25 * 60 * 1000, 'ingestionRecovery', { offset: 16 * MIN });
  // durabilité : checkpoint WAL toutes les 5 min
  schedule(async () => checkpointWal(), 5 * 60 * 1000, 'walCheckpoint', { offset: 100 * S, exclusive: false });
  console.log('[PRONO SPORT] Scheduler démarré (live 60s, fixtures 10min, résultats 15min, monde 20min, découverte 6h).');
}
export function stopScheduler() { timers.forEach(clearInterval); timers = []; }
