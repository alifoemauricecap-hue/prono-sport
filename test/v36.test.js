// PRONO SPORT — tests v3.6 (hors ligne) : scores exacts, trajectoire Elo,
// rapport de backtest persisté, backtest value sur cotes réelles en base.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, now } = await import('../src/db.js');
const { scorelines, eloHistory, backtestReport } = await import('../src/engine/insights.js');
const { loadFinishedMatches, walkForwardBacktest } = await import('../src/engine/models.js');
const { CONFIG } = await import('../src/config.js');

// ---- jeu de données ----
db.prepare(`INSERT INTO competitions (code, name) VALUES ('T36','Ligue T36')`).run();
const compId = db.prepare(`SELECT id FROM competitions WHERE code='T36'`).get().id;
const tid = (n) => db.prepare(`INSERT INTO teams (name, normalized_name) VALUES (?,?)`).run(n, n.toLowerCase()).lastInsertRowid;
const T = ['Aigles', 'Buffles', 'Cobras', 'Dauphins', 'Élans', 'Faucons'].map(tid);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// 260 matchs terminés : les 3 premières équipes (fortes) battent presque toujours
// les 3 dernières (faibles) ; cotes 1X2 réelles insérées pour chaque match.
const insF = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, home_score, away_score, source_ids)
    VALUES (?,?,?,?,'FINISHED',?,?,'["test"]')`);
const insO = db.prepare(`INSERT INTO odds (fixture_id, bookmaker_code, market_code, selection, price, source_id, retrieved_at)
    VALUES (?,?,?,?,?,?,?)`);
let day = Date.parse('2024-01-05T15:00:00Z');
let k = 0;
for (let round = 0; round < 44 && k < 260; round++) {
  for (let i = 0; i < 3 && k < 260; i++) {
    for (let j = 3; j < 6 && k < 260; j++) {
      const homeStrong = (k % 2 === 0);
      const home = homeStrong ? T[i] : T[j];
      const away = homeStrong ? T[j] : T[i];
      // l'équipe forte gagne 2-0 (sauf 1 match sur 10 : nul 1-1)
      const drawGame = k % 10 === 9;
      const hs = drawGame ? 1 : (homeStrong ? 2 : 0);
      const as2 = drawGame ? 1 : (homeStrong ? 0 : 2);
      const fid = insF.run(compId, home, away, iso(new Date(day)), hs, as2).lastInsertRowid;
      // cotes réelles simulées : bookmaker sous-estime l'équipe forte → edge
      insO.run(fid, 'B365', '1X2', 'HOME', homeStrong ? 1.9 : 4.0, 'test', now());
      insO.run(fid, 'B365', '1X2', 'DRAW', 3.6, 'test', now());
      insO.run(fid, 'B365', '1X2', 'AWAY', homeStrong ? 4.0 : 1.9, 'test', now());
      day += 36 * 3600_000; k++;
    }
  }
}

test('🧪 walkForwardBacktest : backtest value sur cotes réelles en base', () => {
  const matches = loadFinishedMatches(compId);
  assert.ok(matches.length >= 200);
  const bt = walkForwardBacktest(matches);
  assert.ok(bt, 'backtest calculé');
  assert.ok(bt.nTest >= 30);
  assert.ok(bt.calibration.length === 10);
  // le déséquilibre fort/faible + cotes généreuses doivent produire des paris value
  assert.ok(bt.value, 'backtest value présent');
  assert.ok(bt.value.bets >= 10);
  assert.ok(bt.value.roi > 0, `ROI attendu positif sur ce jeu biaisé (obtenu ${bt.value.roi})`);
  assert.ok(bt.value.by_season.length >= 1);
  assert.equal(bt.value.min_edge, CONFIG.value.minEdge);
});

test('🎯 scorelines : matrice de Poisson depuis les lambdas stockés', () => {
  const fid = db.prepare(`SELECT id FROM fixtures LIMIT 1`).get().id;
  db.prepare(`INSERT INTO model_outputs (fixture_id, model_name, model_version, p_home, p_draw, p_away, lambda_home, lambda_away, computed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(fid, 'ensemble', 'v36', 0.5, 0.3, 0.2, 1.8, 0.9, now());
  const s = scorelines(fid, 6);
  assert.ok(s);
  assert.equal(s.scores.length, 6);
  assert.equal(s.lambdas.home, 1.8);
  // le score le plus probable pour λ=1.8/0.9 doit être un score bas favorable au domicile
  assert.ok(s.scores[0].p > s.scores[5].p);
  const total = s.scores.reduce((a, x) => a + x.p, 0) + s.others_p;
  assert.ok(Math.abs(total - 1) < 0.01, 'les probabilités somment à ~1');
  assert.equal(scorelines(999999), null, 'null honnête sans sortie de modèle');
});

test('📈 eloHistory : trajectoire rejouée sur les résultats réels', () => {
  const h = eloHistory(T[0], 40);
  assert.ok(h);
  assert.equal(h.competition, 'Ligue T36');
  assert.ok(h.points.length > 5 && h.points.length <= 40);
  // équipe forte : l'Elo final doit dépasser le 1500 initial
  assert.ok(h.current > 1500, `Elo final ${h.current} attendu > 1500`);
  const weak = eloHistory(T[5], 40);
  assert.ok(weak.current < 1500, `Elo faible ${weak.current} attendu < 1500`);
  assert.equal(eloHistory(999999), null);
});

test('🧪 backtestReport : agrégation des métriques persistées', () => {
  db.prepare(`INSERT INTO model_versions (version, description, trained_at, training_matches,
      backtest_brier, backtest_logloss, weights, calibration_json, value_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`${CONFIG.modelVersion}-comp${compId}`, 'test', now(), 260, 0.18, 0.95,
      JSON.stringify({ elo: 0.3, poisson: 0.3, dixonColes: 0.4 }),
      JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ bin: `${i * 10}-${(i + 1) * 10}%`, n: 10, predicted: (i + 0.5) / 10, observed: (i + 0.5) / 10 }))),
      JSON.stringify({ min_edge: 0.03, bets: 50, wins: 30, profit: 12.5, roi: 0.25, by_season: [{ season: '2024/25', bets: 50, wins: 30, profit: 12.5, roi: 0.25 }] }));
  const r = backtestReport();
  assert.ok(r.competitions.length >= 1);
  const c = r.competitions.find((x) => x.code === 'T36');
  assert.ok(c);
  assert.equal(c.matches, 260);
  assert.equal(c.value.bets, 50);
  assert.ok(r.calibration.length === 10);
  assert.ok(r.value_global.bets >= 50);
  assert.ok(r.global_brier != null);
  assert.ok(r.method.includes('walk-forward') || r.method.includes('Walk-forward'));
});
