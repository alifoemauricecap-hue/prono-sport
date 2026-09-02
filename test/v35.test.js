// PRONO SPORT — tests v3.5 (hors ligne) : forme & momentum, comparateur
// modèle vs marché, calendrier ±7 j, explication de pick, archives de sélections.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, now } = await import('../src/db.js');
const { teamForm, modelVsMarket, calendarCounts, explainPick, selectionsHistory } = await import('../src/engine/insights.js');

// ---- jeu de données ----
db.prepare(`INSERT INTO competitions (code, name) VALUES ('T35','Ligue T35')`).run();
const compId = db.prepare(`SELECT id FROM competitions WHERE code='T35'`).get().id;
const tid = (n) => db.prepare(`INSERT INTO teams (name, normalized_name) VALUES (?,?)`).run(n, n.toLowerCase()).lastInsertRowid;
const A = tid('Alpha FC'), B = tid('Beta United'), C = tid('Gamma SC');

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const daysAgo = (n) => iso(new Date(Date.now() - n * 24 * 3600_000));
const inHours = (n) => iso(new Date(Date.now() + n * 3600_000));

// Historique de A : 10 matchs terminés — 5 récents gagnés (dom), 5 anciens perdus (ext)
const insF = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, home_score, away_score, source_ids)
    VALUES (?,?,?,?,'FINISHED',?,?,'["test"]')`);
for (let i = 0; i < 5; i++) insF.run(compId, A, B, daysAgo(3 + i * 4), 2, 0);   // A dom : 5 V
for (let i = 0; i < 5; i++) insF.run(compId, B, A, daysAgo(30 + i * 4), 3, 1);  // A ext : 5 D
// Match à venir dans 20 h avec pronostic coté
const fut = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, source_ids)
    VALUES (?,?,?,?,'SCHEDULED','["test"]')`).run(compId, A, C, inHours(20)).lastInsertRowid;
const predId = db.prepare(`INSERT INTO predictions (fixture_id, created_at, model_version, market, selection,
    probability, market_probability, odds, edge, ev, decision, result, data_quality)
    VALUES (?,?,?,'1X2','HOME',0.66,0.55,1.82,0.11,0.20,'VALUE BET','PENDING',0.8)`).run(fut, now(), 'v35').lastInsertRowid;
// Sélections quotidiennes archivées
db.prepare(`INSERT INTO daily_selections (day, type, status, legs_json, combined_odds, combined_probability, created_at)
    VALUES ('2026-08-30','EXPERT','WON', ?, 1.8, 0.66, ?)`)
  .run(JSON.stringify([{ fixture_id: fut, market: '1X2', selection: 'HOME', adjusted_probability: 0.66, odds: 1.8, home_name: 'Alpha FC', away_name: 'Gamma SC', result: 'WIN' }]), now());
db.prepare(`INSERT INTO daily_selections (day, type, status, legs_json, combined_odds, combined_probability, created_at)
    VALUES ('2026-08-31','SAFE_COMBO','LOST', ?, 3.1, 0.4, ?)`)
  .run(JSON.stringify([]), now());

test('📈 teamForm : série, momentum et splits domicile/extérieur exacts', () => {
  const f = teamForm(A, 10);
  assert.equal(f.games.length, 10);
  assert.equal(f.games.map((g) => g.result).join(''), 'WWWWWLLLLL');
  // 5 derniers = 15 pts (3.0 ppg), 5 précédents = 0 pt
  assert.equal(f.momentum.last5_ppg, 3);
  assert.equal(f.momentum.prev5_ppg, 0);
  assert.equal(f.momentum.trend, 'UP');
  assert.equal(f.home.n, 5); assert.equal(f.home.w, 5);
  assert.equal(f.away.n, 5); assert.equal(f.away.w, 0);
  assert.ok(Math.abs(f.avg_gf - 1.5) < 0.001); // (5×2 + 5×1)/10
});

test('🧮 modelVsMarket : écart modèle-marché sur pronostics cotés en attente', () => {
  const rows = modelVsMarket({ hours: 48, limit: 10 });
  assert.ok(rows.length >= 1);
  const r = rows.find((x) => x.prediction_id === predId);
  assert.ok(r);
  assert.ok(Math.abs(r.gap - 0.11) < 0.001); // 0.66 − 0.55
  assert.equal(r.selection, 'HOME');
});

test('📅 calendarCounts : compte matchs et picks par jour sur ±7 j', () => {
  const cal = calendarCounts(7, 7);
  assert.equal(cal.length, 15);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(cal.some((d) => d.day === today));
  const futDay = inHours(20).slice(0, 10);
  const row = cal.find((d) => d.day === futDay);
  assert.ok(row && row.fixtures >= 1 && row.picks >= 1);
});

test('🔍 explainPick : phrases factuelles chiffrées en français', () => {
  const ex = explainPick(predId);
  assert.ok(ex);
  assert.ok(Array.isArray(ex.reasons) && ex.reasons.length >= 2);
  assert.ok(ex.probability === 0.66);
  const all = ex.reasons.join(' ');
  assert.ok(/valeur|marché|forme|Alpha/i.test(all));
});

test('🧾 selectionsHistory : archives filtrées par type avec legs', () => {
  const exp = selectionsHistory('EXPERT', 10);
  assert.equal(exp.length, 1);
  assert.equal(exp[0].status, 'WON');
  assert.equal(exp[0].legs.length, 1);
  assert.equal(exp[0].legs[0].result, 'WIN');
  const combo = selectionsHistory('SAFE_COMBO', 10);
  assert.equal(combo.length, 1);
  assert.equal(combo[0].status, 'LOST');
});
