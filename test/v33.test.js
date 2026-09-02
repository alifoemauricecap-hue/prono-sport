// PRONO SPORT — tests v3.3 (hors ligne, aucune requête réseau)
// Pronostic d'analyse sans cotes, conversion de cotes américaines,
// exclusion des picks triviaux, honnêteté conservée sur probas faibles.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { analyzeMarkets } = await import('../src/engine/value.js');
const { americanToDecimal } = await import('../src/providers/espn.js');

test('americanToDecimal : conversions moneyline → décimale', () => {
  assert.equal(americanToDecimal(155), 2.55);
  assert.equal(americanToDecimal(-170), 1.59);
  assert.equal(americanToDecimal(220), 3.2);
  assert.equal(americanToDecimal(0), null);
  assert.equal(americanToDecimal('abc'), null);
});

test('sans cotes en base → ANALYSIS PICK sur le marché le plus probable', () => {
  const r = analyzeMarkets(999999, {
    '1X2': { HOME: 0.61, DRAW: 0.22, AWAY: 0.17 },
    'OU2.5': { OVER: 0.35, UNDER: 0.65 },
    DC: { '1X': 0.83, X2: 0.39, '12': 0.78 },
  }, 0.7, 0.6);
  assert.equal(r.decision, 'ANALYSIS PICK');
  assert.equal(r.best.market, 'DC');
  assert.equal(r.best.selection, '1X');
  assert.ok(r.best.analysisOnly);
  assert.ok(r.best.fairOdds > 1);
  assert.match(r.note, /MODEL ESTIMATE/);
});

test('probas toutes < 58 % → NO QUALIFIED PICK conservé (jamais de pick forcé)', () => {
  const r = analyzeMarkets(999998, { '1X2': { HOME: 0.4, DRAW: 0.3, AWAY: 0.3 } }, 0.7, 0.6);
  assert.equal(r.decision, 'NO QUALIFIED PICK');
  assert.equal(r.best, null);
});

test('sélections quasi certaines (> 98,5 %) exclues du pronostic d\'analyse', () => {
  const r = analyzeMarkets(999997, { DC: { '1X': 0.99, X2: 0.6, '12': 0.99 } }, 0.7, 0.6);
  assert.ok(!r.best || r.best.pModel <= 0.985);
});

test('qualité de données insuffisante → pas de pronostic d\'analyse', () => {
  const r = analyzeMarkets(999996, { '1X2': { HOME: 0.7, DRAW: 0.2, AWAY: 0.1 } }, 0.1, 0.6);
  assert.equal(r.decision, 'NO QUALIFIED PICK');
});
