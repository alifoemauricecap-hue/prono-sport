// PRONO SPORT — Modèle Elo (MODEL ESTIMATE)
// Elo classique adapté au football : K variable selon la marge, avantage domicile
// estimé à partir des données réelles. Entraîné chronologiquement (pas de fuite §34).
export const ELO_START = 1500;
const K_BASE = 20;
const HOME_ADV = 60; // points Elo — ordre de grandeur standard, ré-estimé au backtest

export function expectedHome(eloHome, eloAway, homeAdv = HOME_ADV) {
  return 1 / (1 + 10 ** ((eloAway - (eloHome + homeAdv)) / 400));
}

/**
 * Met à jour les ratings après un match réel.
 * marge de victoire → multiplicateur (méthode World Football Elo Ratings)
 */
export function updateElo(ratings, homeKey, awayKey, homeGoals, awayGoals) {
  const rh = ratings.get(homeKey) ?? ELO_START;
  const ra = ratings.get(awayKey) ?? ELO_START;
  const exp = expectedHome(rh, ra);
  const actual = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
  const diff = Math.abs(homeGoals - awayGoals);
  const marginMult = diff <= 1 ? 1 : diff === 2 ? 1.5 : (11 + diff) / 8;
  const delta = K_BASE * marginMult * (actual - exp);
  ratings.set(homeKey, rh + delta);
  ratings.set(awayKey, ra - delta);
  return { rh: rh + delta, ra: ra - delta };
}

/**
 * Probabilités 1X2 à partir de l'écart Elo.
 * Le taux de nuls est calibré sur la fréquence observée dans les données
 * d'entraînement (drawRate), pas une constante inventée.
 */
export function eloProbabilities(eloHome, eloAway, drawRate) {
  const e = expectedHome(eloHome, eloAway);
  // partage de l'espérance entre victoire et nul, proportionnel au drawRate observé
  const pDraw = drawRate * (1 - Math.abs(2 * e - 1) * 0.5);
  const pHome = Math.max(0.01, e - pDraw / 2);
  const pAway = Math.max(0.01, (1 - e) - pDraw / 2);
  const s = pHome + pDraw + pAway;
  return { home: pHome / s, draw: pDraw / s, away: pAway / s };
}
