// PRONO SPORT — tests v3.4 (hors ligne) : Pronos d'Or, Transparence,
// handicaps asiatiques (probabilités + règlement), face-à-face.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, now } = await import('../src/db.js');
const { goldenPicks, transparencyReport, headToHead, marketLabel } = await import('../src/engine/insights.js');
const { evaluateSelection } = await import('../src/engine/predictions.js');
const { scoreMatrix, marketsFromMatrix } = await import('../src/engine/poisson.js');

// ---- jeu de données ----
db.prepare(`INSERT INTO competitions (code, name) VALUES ('T34','Ligue T34')`).run();
const compId = db.prepare(`SELECT id FROM competitions WHERE code='T34'`).get().id;
const tid = (n) => db.prepare(`INSERT INTO teams (name, normalized_name) VALUES (?,?)`).run(n, n.toLowerCase()).lastInsertRowid;
const A = tid('Alpha FC'), B = tid('Beta United'), C = tid('Gamma SC'), D = tid('Delta Town');
const future = new Date(Date.now() + 20 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const past = new Date(Date.now() - 40 * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fut = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, source_ids)
    VALUES (?,?,?,?,'SCHEDULED','["test"]')`).run(compId, A, B, future).lastInsertRowid;
// historique réglé : 3 WIN @2.0, 1 LOSS — et un H2H terminé
const oldF = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, home_score, away_score, source_ids)
    VALUES (?,?,?,?,'FINISHED',2,1,'["test"]')`).run(compId, A, B, past).lastInsertRowid;
const ins = db.prepare(`INSERT INTO predictions (fixture_id, created_at, model_version, market, selection, probability, odds, decision, result)
    VALUES (?,?,?,'1X2','HOME',?,?,?,?)`);
for (let i = 0; i < 12; i++) ins.run(oldF, now(), 't' + i, 0.6, 2.0, 'PICK', i < 8 ? 'WIN' : 'LOSS');
ins.run(fut, now(), 't', 0.71, 1.5, 'VALUE BET', 'PENDING');

test('💎 goldenPicks : classement, étoiles, fiabilité historique réelle', () => {
  const picks = goldenPicks({ hours: 48, limit: 10 });
  assert.ok(picks.length >= 1);
  const p = picks[0];
  assert.equal(p.fixture_id, fut);
  assert.ok(p.stars >= 1 && p.stars <= 5);
  assert.ok(p.probability > 0 && p.probability <= 1);
  // 12 pronostics 1X2 réglés, 8 gagnés → fiabilité 8/12
  assert.ok(Math.abs(p.reliability - 8 / 12) < 0.001);
  assert.equal(p.label, 'Victoire domicile (1)');
});

test('📊 transparencyReport : réussite et ROI exacts (mise fixe 1 u.)', () => {
  const t = transparencyReport();
  assert.equal(t.global.n, 12);
  assert.ok(Math.abs(t.global.win_rate - 8 / 12) < 0.001);
  // 8 WIN @2.0 → +8 ; 4 LOSS → −4 ; net +4 sur 12 paris → ROI +33,33 %
  assert.ok(Math.abs(t.global.roi - 4 / 12) < 0.001);
  assert.ok(t.by_market.length >= 1);
  assert.ok(t.method.includes('mise fixe'));
});

test('⚔️ headToHead : confrontations réelles terminées uniquement', () => {
  const h = headToHead(A, B);
  assert.equal(h.length, 1);
  assert.equal(h[0].home_score, 2);
  const none = headToHead(C, D);
  assert.equal(none.length, 0);
});

test('handicaps asiatiques : probabilités cohérentes depuis la matrice', () => {
  const M = scoreMatrix(1.6, 1.1, 0);
  const mk = marketsFromMatrix(M);
  // AH-0.5 HOME = victoire domicile exactement
  assert.ok(Math.abs(mk['AH-0.5'].HOME - mk['1X2'].HOME) < 1e-9);
  // AH+0.5 HOME = 1X (domicile ou nul)
  assert.ok(Math.abs(mk['AH+0.5'].HOME - (mk['1X2'].HOME + mk['1X2'].DRAW)) < 1e-9);
  // sommes = 1, et -1.5 plus dur que -0.5
  for (const k of ['AH-0.5', 'AH+0.5', 'AH-1.5', 'AH+1.5']) {
    assert.ok(Math.abs(mk[k].HOME + mk[k].AWAY - 1) < 1e-9, k + ' somme=1');
  }
  assert.ok(mk['AH-1.5'].HOME < mk['AH-0.5'].HOME);
});

test('règlement des handicaps : evaluateSelection AH', () => {
  assert.equal(evaluateSelection('AH-0.5', 'HOME', 2, 1), true);   // 2-1 : -0.5 couvert
  assert.equal(evaluateSelection('AH-0.5', 'HOME', 1, 1), false);  // nul : perdu
  assert.equal(evaluateSelection('AH-0.5', 'AWAY', 1, 1), true);   // +0.5 extérieur : gagné
  assert.equal(evaluateSelection('AH-1.5', 'HOME', 3, 1), true);   // 3-1 : couvert
  assert.equal(evaluateSelection('AH-1.5', 'HOME', 2, 1), false);  // 2-1 : raté
  assert.equal(evaluateSelection('AH+1.5', 'AWAY', 0, 2), true);   // extérieur -1.5 : couvert
  assert.equal(evaluateSelection('AH+1.5', 'HOME', 1, 2), true);   // +1.5 domicile : couvert
});

test('marketLabel : libellés FR', () => {
  assert.equal(marketLabel('OU2.5', 'UNDER'), 'Moins de 2,5 buts');
  assert.equal(marketLabel('AH-1.5', 'HOME'), 'Handicap -1,5 domicile');
});
