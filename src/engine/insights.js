// PRONO SPORT — INSIGHTS ENGINE (v3.4)
// 💎 Pronos d'Or : les picks les plus sûrs du moment, tous marchés confondus,
//    classés par probabilité calibrée, avec étoiles et fiabilité historique.
// 📊 Transparence : performance publique réelle (taux de réussite, ROI simulé
//    à mise fixe 1 unité) par marché, par compétition, par tranche de
//    probabilité — CALCULATED DATA, uniquement sur résultats réels réglés.
import { db } from '../db.js';
import { getCalibrationShrink, sameRealMatch } from './daily.js';

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

/** Libellés FR des marchés (affichage professionnel). */
export const MARKET_LABELS = {
  '1X2/HOME': 'Victoire domicile (1)', '1X2/DRAW': 'Match nul (N)', '1X2/AWAY': 'Victoire extérieur (2)',
  'OU2.5/OVER': 'Plus de 2,5 buts', 'OU2.5/UNDER': 'Moins de 2,5 buts',
  'BTTS/YES': 'Les deux équipes marquent', 'BTTS/NO': 'Une équipe ne marque pas',
  'DC/1X': 'Domicile ou nul (1N)', 'DC/X2': 'Nul ou extérieur (N2)', 'DC/12': 'Pas de match nul (12)',
  'AH-0.5/HOME': 'Handicap -0,5 domicile', 'AH-0.5/AWAY': 'Handicap +0,5 extérieur',
  'AH-1.5/HOME': 'Handicap -1,5 domicile', 'AH-1.5/AWAY': 'Handicap +1,5 extérieur',
  'AH+0.5/HOME': 'Handicap +0,5 domicile', 'AH+0.5/AWAY': 'Handicap -0,5 extérieur',
  'AH+1.5/HOME': 'Handicap +1,5 domicile', 'AH+1.5/AWAY': 'Handicap -1,5 extérieur',
};
export const marketLabel = (market, selection) =>
  MARKET_LABELS[`${market}/${selection}`] || `${market} / ${selection}`;

/** Fiabilité historique par marché : % de réussite réel sur les pronostics
 *  réglés (min. 10 réglés pour être significatif — sinon null, jamais inventé). */
export function marketReliability() {
  const rows = db.prepare(`SELECT market,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS w,
      COUNT(*) AS n
      FROM predictions WHERE result IN ('WIN','LOSS') GROUP BY market`).all();
  const out = {};
  for (const r of rows) out[r.market] = r.n >= 10 ? round4(r.w / r.n) : null;
  return out;
}

const starsFor = (p) => p >= 0.85 ? 5 : p >= 0.75 ? 4 : p >= 0.65 ? 3 : p >= 0.58 ? 2 : 1;

/** 💎 PRONOS D'OR : les pronostics à venir (fenêtre 48 h) les plus sûrs,
 *  tous marchés confondus, dédoublonnés, avec étoiles + fiabilité marché. */
export function goldenPicks({ hours = 48, limit = 14 } = {}) {
  const shrink = getCalibrationShrink();
  const reliab = marketReliability();
  const rows = db.prepare(`SELECT p.id AS prediction_id, p.fixture_id, p.market, p.selection,
      p.probability, p.odds, p.decision, p.confidence, p.data_quality,
      f.kickoff_utc, f.status, c.code AS comp_code, c.name AS comp_name, c.logo_url AS comp_logo,
      ht.name AS home_name, ht.badge_url AS home_badge,
      at2.name AS away_name, at2.badge_url AS away_badge
      FROM predictions p
      JOIN fixtures f ON f.id=p.fixture_id
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE p.result='PENDING' AND p.decision IN ('PICK','VALUE BET','ANALYSIS PICK')
        AND f.status IN ('SCHEDULED','UPCOMING')
        AND f.kickoff_utc BETWEEN datetime('now') AND datetime('now', ?)
      ORDER BY p.probability DESC LIMIT 300`).all(`+${hours} hours`);
  const picks = rows
    .map((r) => ({ ...r, adjusted: round4(r.probability * shrink) }))
    // 1 pick par match, puis dédoublonnage inter-sources (même match réel)
    .filter((r, i, arr) => arr.findIndex((x) => x.fixture_id === r.fixture_id) === i)
    .filter((r, i, arr) => !arr.slice(0, i).some((x) => sameRealMatch(x, r)))
    .sort((a, b) => b.adjusted - a.adjusted)
    .slice(0, limit)
    .map((r) => ({
      prediction_id: r.prediction_id, fixture_id: r.fixture_id,
      market: r.market, selection: r.selection,
      label: marketLabel(r.market, r.selection),
      probability: r.adjusted, raw_probability: r.probability,
      stars: starsFor(r.adjusted),
      reliability: reliab[r.market] ?? null,
      odds: r.odds, decision: r.decision,
      kickoff_utc: r.kickoff_utc,
      home_name: r.home_name, away_name: r.away_name,
      home_badge: r.home_badge, away_badge: r.away_badge,
      comp_code: r.comp_code, comp_name: r.comp_name, comp_logo: r.comp_logo,
    }));
  return picks;
}

/** 📊 TRANSPARENCE : performance publique — uniquement des résultats réels.
 *  ROI simulé : mise fixe de 1 unité sur chaque pronostic réglé
 *  (WIN → +(cote−1), LOSS → −1). CALCULATED DATA. */
export function transparencyReport() {
  const settledWhere = `result IN ('WIN','LOSS')`;
  const roiExpr = `SUM(CASE WHEN result='WIN' THEN COALESCE(odds,0)-1 ELSE -1 END)`;
  const global = db.prepare(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS wins,
      ${roiExpr} AS units
      FROM predictions WHERE ${settledWhere}`).get();
  const byMarket = db.prepare(`SELECT market, COUNT(*) AS n,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS wins,
      ${roiExpr} AS units, AVG(probability) AS avg_prob
      FROM predictions WHERE ${settledWhere} GROUP BY market ORDER BY n DESC`).all();
  const byCompetition = db.prepare(`SELECT c.code, c.name, COUNT(*) AS n,
      SUM(CASE WHEN p.result='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN p.result='WIN' THEN COALESCE(p.odds,0)-1 ELSE -1 END) AS units
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      JOIN competitions c ON c.id=f.competition_id
      WHERE p.result IN ('WIN','LOSS') GROUP BY c.id HAVING n >= 3 ORDER BY n DESC LIMIT 30`).all();
  const byDecision = db.prepare(`SELECT decision, COUNT(*) AS n,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) AS wins, ${roiExpr} AS units
      FROM predictions WHERE ${settledWhere} GROUP BY decision`).all();
  // CALIBRATION : probabilité annoncée vs réalité, par tranche de 10 points
  const calibration = db.prepare(`SELECT
      CAST(probability*10 AS INTEGER) AS bucket, COUNT(*) AS n,
      AVG(probability) AS predicted,
      AVG(CASE WHEN result='WIN' THEN 1.0 ELSE 0.0 END) AS actual
      FROM predictions WHERE ${settledWhere} GROUP BY bucket HAVING n >= 5 ORDER BY bucket`).all();
  // série quotidienne des 14 derniers jours réglés
  const daily = db.prepare(`SELECT date(f.kickoff_utc) AS day,
      SUM(CASE WHEN p.result='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN p.result='LOSS' THEN 1 ELSE 0 END) AS losses
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE p.result IN ('WIN','LOSS') AND f.kickoff_utc > datetime('now','-14 days')
      GROUP BY day ORDER BY day`).all();
  const fmt = (r) => ({ ...r, win_rate: r.n ? round4(r.wins / r.n) : null, roi: r.n ? round4(r.units / r.n) : null });
  return {
    global: fmt(global),
    by_market: byMarket.map((r) => ({ ...fmt(r), label_hint: r.market })),
    by_competition: byCompetition.map(fmt),
    by_decision: byDecision.map(fmt),
    calibration: calibration.map((r) => ({
      bucket: `${r.bucket * 10}-${r.bucket * 10 + 9}%`, n: r.n,
      predicted: round4(r.predicted), actual: round4(r.actual),
      gap: round4(r.actual - r.predicted),
    })),
    daily_last14: daily,
    method: 'ROI simulé : mise fixe 1 unité par pronostic réglé (WIN → +(cote−1), LOSS → −1). Résultats réels uniquement — CALCULATED DATA, aucune extrapolation.',
  };
}

/** Face-à-face : dernières confrontations réelles entre deux équipes (toutes
 *  compétitions en base), matchs terminés uniquement — SOURCE DATA. */
export function headToHead(homeId, awayId, limit = 10) {
  return db.prepare(`SELECT f.id, f.kickoff_utc, f.home_score, f.away_score,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name, c.code AS comp_code
      FROM fixtures f
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id
      WHERE f.status='FINISHED' AND f.home_score IS NOT NULL
        AND ((f.home_team_id=? AND f.away_team_id=?) OR (f.home_team_id=? AND f.away_team_id=?))
      ORDER BY f.kickoff_utc DESC LIMIT ?`)
    .all(homeId, awayId, awayId, homeId, limit);
}
