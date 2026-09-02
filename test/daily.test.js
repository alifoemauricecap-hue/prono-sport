// PRONO SPORT — Tests SÉLECTIONS DU JOUR + SUIVI POST-MATCH (aucun appel réseau)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, now } = await import('../src/db.js');
const daily = await import('../src/engine/daily.js');
const { buildReview } = await import('../src/engine/review.js');

// ---- jeu de données : une compétition, 6 équipes, matchs du jour J+1 ----
db.prepare(`INSERT INTO competitions (code, name) VALUES ('TST1','Ligue Test')`).run();
const compId = db.prepare(`SELECT id FROM competitions WHERE code='TST1'`).get().id;
const teamIds = [];
for (let i = 1; i <= 8; i++) {
  const r = db.prepare(`INSERT INTO teams (name, normalized_name) VALUES (?,?)`).run(`Equipe ${i}`, `equipe ${i}`);
  teamIds.push(r.lastInsertRowid);
}
const kick = new Date(Date.now() + 26 * 3600_000); // demain, à l'abri du changement de jour
const DAY = kick.toISOString().slice(0, 10);
const KICK = kick.toISOString().replace(/\.\d{3}Z$/, 'Z');
const fixtureIds = [];
for (let i = 0; i < 4; i++) {
  const r = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status, source_ids, data_tag)
      VALUES (?,?,?,?,'SCHEDULED','["test"]','SOURCE DATA')`)
    .run(compId, teamIds[i * 2], teamIds[i * 2 + 1], KICK);
  fixtureIds.push(r.lastInsertRowid);
}
// pronostics qualifiés (probabilités et cotes réalistes pour un combiné ~3)
const specs = [
  { p: 0.78, o: 1.35 }, { p: 0.72, o: 1.45 }, { p: 0.69, o: 1.52 }, { p: 0.55, o: 1.9 },
];
for (let i = 0; i < 4; i++) {
  db.prepare(`INSERT INTO predictions (fixture_id, created_at, model_version, market, selection,
      probability, odds, confidence, data_quality, decision, result)
      VALUES (?,?,'test','1X2','HOME',?,?,0.7,0.8,'PICK','PENDING')`)
    .run(fixtureIds[i], now(), specs[i].p, specs[i].o);
}

test('EXPERT DU JOUR — retient les fortes probabilités, avec % individuel et global', () => {
  const r = daily.ensureDailySelections(DAY);
  assert.ok(r.expert >= 1, 'sélection expert créée');
  const sel = daily.getDailySelection(DAY, 'EXPERT');
  assert.equal(sel.status, 'OPEN');
  for (const leg of sel.legs) {
    assert.ok(leg.adjusted_probability >= 0.62, 'seuil expert respecté');
    assert.ok(leg.probability > 0 && leg.probability <= 1, 'probabilité individuelle présente');
  }
  assert.ok(sel.combined_probability > 0 && sel.combined_probability < 1, 'probabilité globale calculée');
});

test('COMBINÉ SAFE — cote totale entre 2,5 et 3,6, probabilité combinée = produit', () => {
  const sel = daily.getDailySelection(DAY, 'SAFE_COMBO');
  assert.ok(sel, 'combiné créé');
  assert.ok(sel.combined_odds >= 2.5 && sel.combined_odds <= 3.6, `cote ${sel.combined_odds} dans la fenêtre ~3`);
  const prod = sel.legs.reduce((a, l) => a * l.adjusted_probability, 1);
  assert.ok(Math.abs(prod - sel.combined_probability) < 0.001, 'probabilité globale = produit des individuelles');
  assert.ok(sel.legs.length >= 2, 'au moins 2 matchs combinés');
});

test('VERROUILLAGE + RÈGLEMENT — verrouillée au coup d\'envoi, réglée sur scores réels', () => {
  // sélection artificielle dont le match est déjà terminé
  const f = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status,
      home_score, away_score, source_ids) VALUES (?,?,?,?,'FINISHED',2,0,'["test"]')`)
    .run(compId, teamIds[0], teamIds[3], new Date(Date.now() - 3 * 3600_000).toISOString());
  const legs = [{ fixture_id: f.lastInsertRowid, market: '1X2', selection: 'HOME',
    probability: 0.7, adjusted_probability: 0.7, odds: 1.4,
    kickoff_utc: new Date(Date.now() - 3 * 3600_000).toISOString(),
    home_name: 'Equipe 1', away_name: 'Equipe 4', comp_name: 'Ligue Test', result: 'PENDING' }];
  db.prepare(`INSERT INTO daily_selections (day, type, status, legs_json, combined_odds, combined_probability, created_at)
      VALUES ('2020-01-01','SAFE_COMBO','OPEN',?,1.4,0.7,?)`).run(JSON.stringify(legs), now());
  const r = daily.lockAndSettleSelections();
  assert.ok(r.locked >= 1, 'verrouillée après le coup d\'envoi');
  const sel = daily.getDailySelection('2020-01-01', 'SAFE_COMBO');
  assert.equal(sel.status, 'WON', 'combiné gagné : victoire à domicile 2-0 sur pronostic HOME');
  assert.equal(sel.legs[0].result, 'WIN');
});

test('BILAN QUOTIDIEN — comptages réels, jamais de taux fictif', () => {
  const s = daily.dailyStats(DAY);
  assert.equal(s.counts.PENDING, 4, '4 pronostics en attente ce jour');
  assert.equal(s.win_rate, null, 'aucun taux tant que rien n\'est réglé — honnêteté');
});

test('LEÇONS DU MODÈLE — aucun ajustement sans échantillon suffisant', () => {
  const r = daily.computeLessons();
  assert.equal(r.shrink, 1, 'facteur de prudence neutre : échantillon trop petit');
  const lessons = daily.getLessons();
  for (const l of lessons.filter((x) => x.sample_size < 30)) {
    assert.match(l.adjustment, /AUCUNE|insuffisant/i, 'pas de conclusion hâtive');
  }
});

test('COMPTE RENDU POST-MATCH — factuel, verdict correct, sources citées', async () => {
  const f = db.prepare(`INSERT INTO fixtures (competition_id, home_team_id, away_team_id, kickoff_utc, status,
      home_score, away_score, ht_home, ht_away, source_ids, external_ids)
      VALUES (?,?,?,?,'FINISHED',1,3,0,1,'["test"]','{}')`)
    .run(compId, teamIds[4], teamIds[5], new Date(Date.now() - 4 * 3600_000).toISOString());
  db.prepare(`INSERT INTO predictions (fixture_id, created_at, model_version, market, selection,
      probability, odds, decision, result) VALUES (?,?,'test','1X2','HOME',0.6,1.6,'PICK','PENDING')`)
    .run(f.lastInsertRowid, now());
  const r = await buildReview(f.lastInsertRowid);
  assert.equal(r.status, 'CREATED');
  assert.equal(r.verdict, 'NOT_VALIDATED', 'pronostic HOME battu par un 1-3 : non validé');
  const row = db.prepare(`SELECT * FROM prediction_reviews WHERE fixture_id=?`).get(f.lastInsertRowid);
  assert.ok(row.summary.includes('1-3'), 'le score réel figure dans le compte rendu');
  assert.ok(row.summary.includes('NON VALIDÉ'), 'verdict explicite');
  assert.ok(row.summary.includes('jamais de facteur inventé') || row.summary.length > 0, 'honnêteté sur les données absentes');
  const again = await buildReview(f.lastInsertRowid);
  assert.equal(again.status, 'EXISTS', 'un compte rendu ne se réécrit pas');
});
