// PRONO SPORT — MODEL ENSEMBLE ENGINE + BACKTEST LAB + CALIBRATION (§30-36)
// Pipeline : DATA → FEATURES → TRAINING → VALIDATION (walk-forward) → CALIBRATION → BACKTEST → PRODUCTION
// Les poids de l'ensemble sont VALIDÉS HISTORIQUEMENT (log-loss walk-forward),
// jamais fixés arbitrairement (§31).
import { db, now } from '../db.js';
import { CONFIG } from '../config.js';
import { ELO_START, updateElo, eloProbabilities } from './elo.js';
import { fitStrengths, expectedGoals, scoreMatrix, marketsFromMatrix, estimateRho } from './poisson.js';

/** Charge les matchs terminés d'une compétition, ordre chronologique strict */
export function loadFinishedMatches(competitionId) {
  return db.prepare(`SELECT f.id, f.kickoff_utc AS ts, f.home_team_id AS homeKey,
      f.away_team_id AS awayKey, f.home_score AS hg, f.away_score AS ag
      FROM fixtures f
      WHERE f.competition_id=? AND f.status='FINISHED'
        AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL
      ORDER BY f.kickoff_utc ASC`).all(competitionId);
}

function brier(probs, outcome) {
  // outcome: 'HOME' | 'DRAW' | 'AWAY'
  const y = { HOME: 0, DRAW: 0, AWAY: 0 }; y[outcome] = 1;
  return ((probs.home - y.HOME) ** 2 + (probs.draw - y.DRAW) ** 2 + (probs.away - y.AWAY) ** 2) / 3;
}
function logloss(probs, outcome) {
  const p = outcome === 'HOME' ? probs.home : outcome === 'DRAW' ? probs.draw : probs.away;
  return -Math.log(Math.max(p, 1e-10));
}
const outcomeOf = (m) => (m.hg > m.ag ? 'HOME' : m.hg < m.ag ? 'AWAY' : 'DRAW');

/**
 * Backtest walk-forward par compétition (§34, §36) :
 * pour chaque match de la fenêtre de test, entraînement UNIQUEMENT sur les
 * matchs antérieurs. Retourne métriques par modèle + poids d'ensemble optimaux.
 */
export function walkForwardBacktest(matches, { testFraction = 0.3, minTrain = 120 } = {}) {
  if (matches.length < minTrain + 40) return null;
  const testStart = Math.max(minTrain, Math.floor(matches.length * (1 - testFraction)));

  // Elo : passage chronologique unique
  const ratings = new Map();
  let drawCount = 0;
  const records = []; // { eloP, poisP, dcP, outcome }
  let fit = null, rho = 0, lastFitAt = -1;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (i >= testStart) {
      // refit Poisson/DC toutes les ~20 obs pour un walk-forward praticable
      if (fit === null || i - lastFitAt >= 20) {
        const train = matches.slice(0, i);
        fit = fitStrengths(train, new Date(m.ts).getTime());
        rho = fit ? estimateRho(train.slice(-300), fit) : 0;
        lastFitAt = i;
      }
      const drawRate = drawCount / Math.max(i, 1);
      const eloP = eloProbabilities(ratings.get(m.homeKey) ?? ELO_START, ratings.get(m.awayKey) ?? ELO_START, drawRate);
      const eg = fit ? expectedGoals(fit, m.homeKey, m.awayKey) : null;
      let poisP = null, dcP = null;
      if (eg) {
        const mk = marketsFromMatrix(scoreMatrix(eg.lambdaHome, eg.lambdaAway, 0))['1X2'];
        poisP = { home: mk.HOME, draw: mk.DRAW, away: mk.AWAY };
        const mkDc = marketsFromMatrix(scoreMatrix(eg.lambdaHome, eg.lambdaAway, rho))['1X2'];
        dcP = { home: mkDc.HOME, draw: mkDc.DRAW, away: mkDc.AWAY };
      }
      if (poisP && dcP) records.push({ eloP, poisP, dcP, outcome: outcomeOf(m) });
    }
    if (m.hg === m.ag) drawCount++;
    updateElo(ratings, m.homeKey, m.awayKey, m.hg, m.ag);
  }
  if (records.length < 30) return null;

  const metric = (get) => {
    let b = 0, ll = 0;
    for (const r of records) { b += brier(get(r), r.outcome); ll += logloss(get(r), r.outcome); }
    return { brier: b / records.length, logloss: ll / records.length };
  };
  const mElo = metric((r) => r.eloP);
  const mPois = metric((r) => r.poisP);
  const mDc = metric((r) => r.dcP);

  // Recherche des poids d'ensemble minimisant le log-loss (grid search, pas de 0.05)
  let best = { w: [1 / 3, 1 / 3, 1 / 3], ll: Infinity };
  for (let a = 0; a <= 10; a++) for (let b2 = 0; b2 <= 10 - a; b2++) {
    const c = 10 - a - b2;
    const w = [a / 10, b2 / 10, c / 10];
    let ll = 0;
    for (const r of records) {
      const p = blend([r.eloP, r.poisP, r.dcP], w);
      ll += logloss(p, r.outcome);
    }
    ll /= records.length;
    if (ll < best.ll) best = { w, ll };
  }
  let ensB = 0;
  for (const r of records) ensB += brier(blend([r.eloP, r.poisP, r.dcP], best.w), r.outcome);

  // Courbe de calibration de l'ensemble (§35)
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, hits: 0 }));
  for (const r of records) {
    const p = blend([r.eloP, r.poisP, r.dcP], best.w);
    for (const [sel, prob] of [['HOME', p.home], ['DRAW', p.draw], ['AWAY', p.away]]) {
      const bin = Math.min(9, Math.floor(prob * 10));
      bins[bin].n++; bins[bin].pSum += prob;
      if (r.outcome === sel) bins[bin].hits++;
    }
  }
  const calibration = bins.map((b3, i) => ({
    bin: `${i * 10}-${(i + 1) * 10}%`,
    n: b3.n,
    predicted: b3.n ? b3.pSum / b3.n : null,
    observed: b3.n ? b3.hits / b3.n : null,
  }));

  return {
    nTest: records.length,
    models: { elo: mElo, poisson: mPois, dixonColes: mDc },
    ensemble: { weights: { elo: best.w[0], poisson: best.w[1], dixonColes: best.w[2] }, logloss: best.ll, brier: ensB / records.length },
    calibration,
  };
}

export function blend(probList, weights) {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < probList.length; i++) {
    home += probList[i].home * weights[i];
    draw += probList[i].draw * weights[i];
    away += probList[i].away * weights[i];
  }
  const s = home + draw + away;
  return { home: home / s, draw: draw / s, away: away / s };
}

/**
 * TRAIN & PREDICT — production (§32) : entraîne sur tout l'historique disponible
 * jusqu'à MAINTENANT (pas de fuite), produit les probabilités pour les matchs à venir.
 */
export function trainCompetition(competitionId) {
  const matches = loadFinishedMatches(competitionId);
  if (matches.length < 60) return null;
  const refTime = Date.now();
  const backtest = walkForwardBacktest(matches);
  const weights = backtest
    ? [backtest.ensemble.weights.elo, backtest.ensemble.weights.poisson, backtest.ensemble.weights.dixonColes]
    : [1 / 3, 1 / 3, 1 / 3];

  const ratings = new Map();
  let drawCount = 0;
  for (const m of matches) {
    if (m.hg === m.ag) drawCount++;
    updateElo(ratings, m.homeKey, m.awayKey, m.hg, m.ag);
  }
  const drawRate = drawCount / matches.length;
  const fit = fitStrengths(matches, refTime);
  const rho = fit ? estimateRho(matches.slice(-400), fit) : 0;

  return { matches: matches.length, ratings, drawRate, fit, rho, weights, backtest };
}

export function predictFixture(model, homeKey, awayKey) {
  const eloP = eloProbabilities(
    model.ratings.get(homeKey) ?? ELO_START,
    model.ratings.get(awayKey) ?? ELO_START,
    model.drawRate);
  const eg = model.fit ? expectedGoals(model.fit, homeKey, awayKey) : null;
  if (!eg) return null; // INSUFFICIENT DATA : équipe sans historique suffisant
  if (Math.min(eg.nHome, eg.nAway) < CONFIG.value.minMatchesPerTeam) return null;
  const mPois = marketsFromMatrix(scoreMatrix(eg.lambdaHome, eg.lambdaAway, 0));
  const mDc = marketsFromMatrix(scoreMatrix(eg.lambdaHome, eg.lambdaAway, model.rho));
  const poisP = { home: mPois['1X2'].HOME, draw: mPois['1X2'].DRAW, away: mPois['1X2'].AWAY };
  const dcP = { home: mDc['1X2'].HOME, draw: mDc['1X2'].DRAW, away: mDc['1X2'].AWAY };
  const ens = blend([eloP, poisP, dcP], model.weights);
  return {
    ensemble: ens,
    perModel: { elo: eloP, poisson: poisP, dixonColes: dcP },
    markets: {
      '1X2': { HOME: ens.home, DRAW: ens.draw, AWAY: ens.away },
      'OU2.5': mDc['OU2.5'],
      BTTS: mDc.BTTS,
      DC: { '1X': ens.home + ens.draw, X2: ens.draw + ens.away, '12': ens.home + ens.away },
    },
    lambdas: { home: eg.lambdaHome, away: eg.lambdaAway },
    depth: { home: eg.nHome, away: eg.nAway },
  };
}
