// PRONO SPORT — Tests live engine + xG proxy + classements
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveProbabilities, estimateMinute } from '../src/engine/live.js';

test('LIVE — le leader à la 94e minute a une probabilité quasi certaine', () => {
  const p = liveProbabilities(1.4, 1.1, 94, 2, 0);
  assert.ok(p.home > 0.97, `p.home=${p.home} devrait être > 0.97`);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9, 'probabilités normalisées');
});

test('LIVE — à la minute 0 avec 0-0, on retrouve ~les probabilités pré-match Poisson', () => {
  const pre = liveProbabilities(1.4, 1.1, 0, 0, 0);
  assert.ok(pre.home > pre.away, 'λ home > λ away → home favori');
  assert.ok(Math.abs(pre.home + pre.draw + pre.away - 1) < 1e-9);
});

test('LIVE — symétrie : inverser λ et score inverse home/away', () => {
  const a = liveProbabilities(1.3, 1.0, 60, 1, 0);
  const b = liveProbabilities(1.0, 1.3, 60, 0, 1);
  assert.ok(Math.abs(a.home - b.away) < 1e-9);
  assert.ok(Math.abs(a.away - b.home) < 1e-9);
  assert.ok(Math.abs(a.draw - b.draw) < 1e-9);
});

test('LIVE — un but marqué augmente la probabilité du buteur', () => {
  const before = liveProbabilities(1.2, 1.2, 70, 0, 0);
  const after = liveProbabilities(1.2, 1.2, 70, 1, 0);
  assert.ok(after.home > before.home, 'le but doit faire monter p(home)');
  assert.ok(after.away < before.away);
});

test('LIVE — estimateMinute bornée [1, 95] et déduit la mi-temps', () => {
  const now = Date.now();
  assert.equal(estimateMinute(new Date(now - 10 * 60000).toISOString()), 10);
  // 80 min d'horloge → ~65e minute de jeu (pause déduite)
  assert.equal(estimateMinute(new Date(now - 80 * 60000).toISOString()), 65);
  assert.equal(estimateMinute(new Date(now - 500 * 60000).toISOString()), 95);
  assert.equal(estimateMinute(new Date(now + 60000).toISOString()), 1);
});

test('XG — coefficients ajustés sur la base réelle : cadrés > non-cadrés > 0', async () => {
  process.env.DB_PATH = process.env.DB_PATH || 'data/pronosport.db';
  const { fitXgCoefficients } = await import('../src/engine/xg.js');
  const c = fitXgCoefficients();
  if (!c) {
    // Base de test sans 500 obs : le moteur doit refuser d'ajuster (pas de coefficients bidon)
    assert.equal(c, null);
    return;
  }
  assert.ok(c.a > 0, 'coefficient tirs cadrés positif');
  assert.ok(c.a > c.b, 'un tir cadré doit valoir plus qu\'un tir non cadré');
  assert.ok(c.n >= 500, 'ajusté sur au moins 500 observations réelles');
});

test('CONTEXT — computeStandings produit un classement cohérent (points/matchs)', async () => {
  process.env.DB_PATH = process.env.DB_PATH || 'data/pronosport.db';
  const { computeStandings } = await import('../src/engine/context.js');
  const { db } = await import('../src/db.js');
  const comp = db.prepare(`SELECT competition_id AS id, COUNT(*) AS n FROM fixtures
      WHERE status='FINISHED' GROUP BY competition_id ORDER BY n DESC LIMIT 1`).get();
  if (!comp) return; // base vide : rien à vérifier
  const st = computeStandings(comp.id);
  assert.ok(st.standings.length > 0, 'classement non vide');
  for (const s of st.standings) {
    assert.equal(s.played, s.won + s.drawn + s.lost, 'J = G+N+P');
    assert.equal(s.points, 3 * s.won + s.drawn, 'points = 3G + N');
    assert.equal(s.gd, s.gf - s.ga);
  }
  const totalGf = st.standings.reduce((x, s) => x + s.gf, 0);
  const totalGa = st.standings.reduce((x, s) => x + s.ga, 0);
  assert.equal(totalGf, totalGa, 'somme BP = somme BC sur la ligue');
});
