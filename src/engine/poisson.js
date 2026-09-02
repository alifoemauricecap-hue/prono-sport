// PRONO SPORT — Modèles Poisson & Dixon-Coles (MODEL ESTIMATE)
// Forces d'attaque/défense estimées sur les matchs réels avec pondération
// temporelle exponentielle (les matchs récents pèsent plus).
// Dixon-Coles : correction rho de la dépendance des petits scores, rho estimé
// par maximum de vraisemblance sur les données d'entraînement (§31 : rien d'arbitraire).

const MAX_GOALS = 10;

export function poissonPmf(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/** Correction Dixon-Coles tau(x, y) pour les scores 0-0, 1-0, 0-1, 1-1 */
export function dcTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Estime les forces par équipe à partir des matchs terminés.
 * @param matches [{homeKey, awayKey, hg, ag, ts}] triés chronologiquement
 * @param halfLifeDays demi-vie de la pondération temporelle
 */
export function fitStrengths(matches, refTime, halfLifeDays = 240) {
  const teams = new Map(); // key -> {attHome, attAway... aggregated}
  const agg = new Map();
  let sumHome = 0, sumAway = 0, wTotal = 0;
  for (const m of matches) {
    const ageDays = (refTime - new Date(m.ts).getTime()) / 86400_000;
    if (ageDays < 0) continue; // ANTI-LEAKAGE : jamais de match futur (§34)
    const w = Math.pow(0.5, ageDays / halfLifeDays);
    sumHome += w * m.hg; sumAway += w * m.ag; wTotal += w;
    for (const [key, gf, ga, isHome] of [[m.homeKey, m.hg, m.ag, true], [m.awayKey, m.ag, m.hg, false]]) {
      if (!agg.has(key)) agg.set(key, { wGf: 0, wGa: 0, w: 0, wHomeGf: 0, wHome: 0, wAwayGf: 0, wAway: 0, n: 0 });
      const a = agg.get(key);
      a.wGf += w * gf; a.wGa += w * ga; a.w += w; a.n += 1;
      if (isHome) { a.wHomeGf += w * gf; a.wHome += w; }
      else { a.wAwayGf += w * gf; a.wAway += w; }
    }
  }
  if (!wTotal) return null;
  const avgHome = sumHome / wTotal; // buts moyens domicile (observé)
  const avgAway = sumAway / wTotal;
  const league = { avgHome, avgAway, avgTotal: (sumHome + sumAway) / wTotal / 2 };
  for (const [key, a] of agg) {
    if (a.w <= 0) continue;
    teams.set(key, {
      attack: (a.wGf / a.w) / league.avgTotal,   // force offensive relative
      defense: (a.wGa / a.w) / league.avgTotal,  // faiblesse défensive relative
      matches: a.n,
    });
  }
  return { teams, league };
}

/** λ attendus pour un match donné à partir des forces estimées */
export function expectedGoals(fit, homeKey, awayKey) {
  const th = fit.teams.get(homeKey), ta = fit.teams.get(awayKey);
  if (!th || !ta) return null;
  const lambdaHome = Math.max(0.05, th.attack * ta.defense * fit.league.avgHome);
  const lambdaAway = Math.max(0.05, ta.attack * th.defense * fit.league.avgAway);
  return { lambdaHome, lambdaAway, nHome: th.matches, nAway: ta.matches };
}

/** Matrice de scores → probabilités des marchés */
export function scoreMatrix(lambdaHome, lambdaAway, rho = 0) {
  const M = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    M[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      let p = poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a);
      if (rho) p *= dcTau(h, a, lambdaHome, lambdaAway, rho);
      p = Math.max(p, 0);
      M[h][a] = p; total += p;
    }
  }
  for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) M[h][a] /= total;
  return M;
}

export function marketsFromMatrix(M) {
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
  for (let h = 0; h < M.length; h++) {
    for (let a = 0; a < M[h].length; a++) {
      const p = M[h][a];
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
      if (h + a > 2.5) over25 += p;
      if (h > 0 && a > 0) btts += p;
    }
  }
  return {
    '1X2': { HOME: home, DRAW: draw, AWAY: away },
    'OU2.5': { OVER: over25, UNDER: 1 - over25 },
    BTTS: { YES: btts, NO: 1 - btts },
    DC: { '1X': home + draw, X2: draw + away, '12': home + away },
    // HANDICAPS ASIATIQUES demi-lignes (v3.4) — probabilités exactes issues
    // de la matrice de scores : HOME couvre si (h + ligne − a) > 0.
    'AH-0.5': { HOME: home, AWAY: draw + away },
    'AH+0.5': { HOME: home + draw, AWAY: away },
    'AH-1.5': ahFromMatrix(M, -1.5),
    'AH+1.5': ahFromMatrix(M, 1.5),
  };
}

/** Probabilités d'un handicap asiatique demi-ligne depuis la matrice. */
function ahFromMatrix(M, line) {
  let homeCovers = 0;
  for (let h = 0; h < M.length; h++) {
    for (let a = 0; a < M[h].length; a++) {
      if (h + line - a > 0) homeCovers += M[h][a];
    }
  }
  return { HOME: homeCovers, AWAY: 1 - homeCovers };
}

/**
 * Estimation de rho (Dixon-Coles) par maximum de vraisemblance (grid search)
 * sur les matchs d'entraînement — validé sur données réelles, pas arbitraire.
 */
export function estimateRho(matches, fit) {
  let bestRho = 0, bestLL = -Infinity;
  for (let rho = -0.15; rho <= 0.15001; rho += 0.01) {
    let ll = 0, n = 0;
    for (const m of matches) {
      const eg = expectedGoals(fit, m.homeKey, m.awayKey);
      if (!eg) continue;
      const h = Math.min(m.hg, MAX_GOALS), a = Math.min(m.ag, MAX_GOALS);
      let p = poissonPmf(eg.lambdaHome, h) * poissonPmf(eg.lambdaAway, a)
        * dcTau(h, a, eg.lambdaHome, eg.lambdaAway, rho);
      if (p <= 0) p = 1e-10;
      ll += Math.log(p); n++;
    }
    if (n && ll > bestLL) { bestLL = ll; bestRho = rho; }
  }
  return Math.round(bestRho * 100) / 100;
}
