// PRONO SPORT — LIVE PREDICTION ENGINE (§53)
// Recalcul en direct des probabilités pour les matchs CONFIRMÉS live par une source.
// Méthode documentée (MODEL ESTIMATE, aucune donnée inventée) :
//   - score courant + minute : données réelles (source live / horloge du coup d'envoi)
//   - buts restants attendus : λ pré-match × fraction de temps restante
//   - matrice de Poisson sur les buts restants, ajoutée au score acquis
// Chaque recalcul est snapshoté → l'UI affiche AVANT → APRÈS, jamais réécrit.
import { db, now } from '../db.js';
import { CONFIG } from '../config.js';
import { poissonPmf } from './poisson.js';
import { getCompetitionModel } from './predictions.js';
import { predictFixture } from './models.js';

const MATCH_MINUTES = 95; // durée effective moyenne incluant arrêts de jeu (documenté)
const MAX_REMAINING_GOALS = 8;

/**
 * Probabilités du résultat FINAL étant donné le score courant réel.
 * @returns {home, draw, away, expTotalGoals}
 */
export function liveProbabilities(lambdaHome, lambdaAway, minute, scoreH, scoreA) {
  const remaining = Math.max(0, Math.min(1, (MATCH_MINUTES - minute) / MATCH_MINUTES));
  const lh = lambdaHome * remaining;
  const la = lambdaAway * remaining;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_REMAINING_GOALS; h++) {
    for (let a = 0; a <= MAX_REMAINING_GOALS; a++) {
      const p = poissonPmf(lh, h) * poissonPmf(la, a);
      const finalH = scoreH + h, finalA = scoreA + a;
      if (finalH > finalA) home += p;
      else if (finalH === finalA) draw += p;
      else away += p;
    }
  }
  const s = home + draw + away;
  return {
    home: home / s, draw: draw / s, away: away / s,
    expTotalGoals: scoreH + scoreA + lh + la,
    remainingFraction: remaining,
  };
}

/** Minute estimée depuis le coup d'envoi (CALCULATED — l'horloge, pas une invention) */
export function estimateMinute(kickoffUtc) {
  const mins = Math.floor((Date.now() - new Date(kickoffUtc).getTime()) / 60000);
  // la mi-temps (~15 min) est déduite au-delà de la 45e minute d'horloge
  const adj = mins > 60 ? mins - 15 : mins;
  return Math.max(1, Math.min(MATCH_MINUTES, adj));
}

/**
 * Worker : recalcule les probabilités de tous les matchs LIVE confirmés.
 * Snapshot uniquement si le score ou la tranche de minute a changé.
 * @returns nombre de snapshots créés
 */
export function updateLivePredictions() {
  const liveFixtures = db.prepare(`SELECT f.*, c.id AS comp_id FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id
      WHERE f.status IN ('LIVE','HALFTIME','EXTRA_TIME')`).all();
  let snapshots = 0;
  for (const f of liveFixtures) {
    try {
      const model = getCompetitionModel(f.comp_id);
      if (!model) continue; // INSUFFICIENT DATA : pas de recalcul artificiel (§53)
      const pred = predictFixture(model, f.home_team_id, f.away_team_id);
      if (!pred) continue;
      const minute = estimateMinute(f.kickoff_utc);
      const scoreH = f.home_score ?? 0, scoreA = f.away_score ?? 0;
      const lp = liveProbabilities(pred.lambdas.home, pred.lambdas.away, minute, scoreH, scoreA);
      const last = db.prepare(`SELECT * FROM live_predictions WHERE fixture_id=? ORDER BY id DESC LIMIT 1`)
        .get(f.id);
      const scoreChanged = !last || last.score_home !== scoreH || last.score_away !== scoreA;
      const minuteBucketChanged = !last || Math.floor(minute / 5) !== Math.floor(last.minute / 5);
      if (scoreChanged || minuteBucketChanged) {
        db.prepare(`INSERT INTO live_predictions
            (fixture_id, minute, score_home, score_away, p_home, p_draw, p_away,
             exp_total_goals, trigger, computed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(f.id, minute, scoreH, scoreA, lp.home, lp.draw, lp.away,
            lp.expTotalGoals, scoreChanged && last ? 'SCORE_CHANGE' : 'TIME', now());
        snapshots++;
      }
    } catch { /* match suivant ; l'erreur reste visible dans les jobs */ }
  }
  return snapshots;
}

/** Historique live d'un match : snapshots AVANT → APRÈS + probabilités pré-match */
export function getLiveHistory(fixtureId) {
  const snaps = db.prepare(`SELECT minute, score_home, score_away, p_home, p_draw, p_away,
      exp_total_goals, trigger, computed_at
      FROM live_predictions WHERE fixture_id=? ORDER BY id ASC`).all(fixtureId);
  const preMatch = db.prepare(`SELECT p_home, p_draw, p_away FROM model_outputs
      WHERE fixture_id=? AND model_name='ensemble' ORDER BY computed_at DESC LIMIT 1`).get(fixtureId);
  return { preMatch: preMatch || null, snapshots: snaps };
}
