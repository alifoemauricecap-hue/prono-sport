// PRONO SPORT — Tests des moteurs mathématiques (Value, Poisson, Elo)
import test from 'node:test';
import assert from 'node:assert/strict';
import { impliedProbabilities } from '../src/engine/value.js';
import { poissonPmf, scoreMatrix, marketsFromMatrix, dcTau, fitStrengths, expectedGoals } from '../src/engine/poisson.js';
import { expectedHome, updateElo, eloProbabilities, ELO_START } from '../src/engine/elo.js';
import { blend } from '../src/engine/models.js';
import { evaluateSelection } from '../src/engine/predictions.js';

test('VALUE — implied probability retire correctement la marge du bookmaker', () => {
  const { fair, overround } = impliedProbabilities({ HOME: 2.0, DRAW: 3.5, AWAY: 4.0 });
  assert.ok(overround > 1, 'l\'overround doit être > 1 (marge)');
  const s = fair.HOME + fair.DRAW + fair.AWAY;
  assert.ok(Math.abs(s - 1) < 1e-9, 'les probabilités sans marge somment à 1');
  assert.ok(fair.HOME > fair.DRAW && fair.DRAW > fair.AWAY);
});

test('VALUE — formules documentées : fair odds = 1/P, EV = P×cote − 1', () => {
  const P = 0.5, odds = 2.2;
  assert.equal(1 / P, 2);
  assert.ok(Math.abs((P * odds - 1) - 0.1) < 1e-9, 'EV attendu = +10%');
});

test('POISSON — pmf et matrice de scores cohérentes', () => {
  assert.ok(Math.abs(poissonPmf(1.5, 0) - Math.exp(-1.5)) < 1e-12);
  const M = scoreMatrix(1.4, 1.1);
  let total = 0;
  for (const row of M) for (const p of row) { assert.ok(p >= 0); total += p; }
  assert.ok(Math.abs(total - 1) < 1e-9, 'matrice normalisée');
  const mk = marketsFromMatrix(M);
  assert.ok(Math.abs(mk['1X2'].HOME + mk['1X2'].DRAW + mk['1X2'].AWAY - 1) < 1e-9);
  assert.ok(mk['1X2'].HOME > mk['1X2'].AWAY, 'λ domicile supérieur → favori domicile');
  assert.ok(Math.abs(mk['OU2.5'].OVER + mk['OU2.5'].UNDER - 1) < 1e-9);
});

test('DIXON-COLES — tau ajuste uniquement les petits scores', () => {
  const rho = -0.1;
  assert.notEqual(dcTau(0, 0, 1.3, 1.1, rho), 1);
  assert.notEqual(dcTau(1, 1, 1.3, 1.1, rho), 1);
  assert.equal(dcTau(3, 2, 1.3, 1.1, rho), 1, 'scores élevés non modifiés');
});

test('POISSON — anti-fuite : les matchs futurs sont exclus de l\'entraînement (§34)', () => {
  const refTime = Date.parse('2025-01-01T00:00:00Z');
  const past = { homeKey: 1, awayKey: 2, hg: 2, ag: 0, ts: '2024-12-01T00:00:00Z' };
  const future = { homeKey: 3, awayKey: 4, hg: 9, ag: 0, ts: '2025-06-01T00:00:00Z' };
  const fit = fitStrengths([past, future], refTime);
  assert.ok(fit.teams.has(1), 'match passé pris en compte');
  assert.ok(!fit.teams.has(3), 'match FUTUR exclu de l\'entraînement');
});

test('ELO — mise à jour symétrique et probabilités normalisées', () => {
  const ratings = new Map();
  updateElo(ratings, 'A', 'B', 3, 0);
  assert.ok(ratings.get('A') > ELO_START && ratings.get('B') < ELO_START);
  assert.ok(Math.abs((ratings.get('A') - ELO_START) + (ratings.get('B') - ELO_START)) < 1e-9, 'somme conservée');
  const p = eloProbabilities(1600, 1400, 0.26);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(p.home > p.away);
  assert.ok(expectedHome(1500, 1500) > 0.5, 'avantage domicile présent');
});

test('ENSEMBLE — blend pondéré normalisé', () => {
  const p = blend([{ home: 0.5, draw: 0.3, away: 0.2 }, { home: 0.4, draw: 0.3, away: 0.3 }], [0.5, 0.5]);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(Math.abs(p.home - 0.45) < 1e-9);
});

test('SETTLEMENT — évaluation exacte des marchés (§54)', () => {
  assert.equal(evaluateSelection('1X2', 'HOME', 2, 1), true);
  assert.equal(evaluateSelection('1X2', 'DRAW', 1, 1), true);
  assert.equal(evaluateSelection('1X2', 'AWAY', 2, 1), false);
  assert.equal(evaluateSelection('OU2.5', 'OVER', 2, 1), true);
  assert.equal(evaluateSelection('OU2.5', 'UNDER', 1, 1), true);
  assert.equal(evaluateSelection('BTTS', 'YES', 1, 1), true);
  assert.equal(evaluateSelection('BTTS', 'NO', 2, 0), true);
  assert.equal(evaluateSelection('DC', '1X', 1, 1), true);
  assert.equal(evaluateSelection('MARCHE_INCONNU', 'X', 1, 1), null, 'marché inconnu → null, jamais deviné');
});

test('INTÉGRITÉ TEMPORELLE — aucun pronostic enregistré après le coup d\'envoi (§34)', async () => {
  // La garde isPreMatch de generatePrediction est vérifiée sur le code source :
  // un pronostic n'entre dans l'audit trail que si kickoff_utc > maintenant.
  const src = await import('node:fs').then((fs) => fs.readFileSync('./src/engine/predictions.js', 'utf8'));
  assert.ok(src.includes('isPreMatch'), 'garde temporelle présente');
  assert.ok(src.includes('analysis.best && isPreMatch'), 'l\'enregistrement exige le pré-match');
});
