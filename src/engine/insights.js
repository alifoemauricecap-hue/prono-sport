// PRONO SPORT — INSIGHTS ENGINE (v3.4)
// 💎 Pronos d'Or : les picks les plus sûrs du moment, tous marchés confondus,
//    classés par probabilité calibrée, avec étoiles et fiabilité historique.
// 📊 Transparence : performance publique réelle (taux de réussite, ROI simulé
//    à mise fixe 1 unité) par marché, par compétition, par tranche de
//    probabilité — CALCULATED DATA, uniquement sur résultats réels réglés.
import { db } from '../db.js';
import { getCalibrationShrink, sameRealMatch } from './daily.js';
import { scoreMatrix } from './poisson.js';
import { ELO_START, updateElo } from './elo.js';
import { CONFIG } from '../config.js';

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

/* ---------------- v3.5 : forme, comparateur, calendrier, explications, archives ---------------- */

/** 📈 Forme d'une équipe : N derniers matchs terminés (toutes compétitions en
 *  base), série V/N/D, splits domicile-extérieur, momentum (5 derniers vs 5
 *  précédents en points/match) — SOURCE DATA agrégée (CALCULATED DATA). */
export function teamForm(teamId, limit = 10) {
  const rows = db.prepare(`SELECT f.id, f.kickoff_utc, f.home_team_id, f.away_team_id,
      f.home_score AS hs, f.away_score AS as2,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name
      FROM fixtures f
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.status='FINISHED'
        AND f.home_score IS NOT NULL
      ORDER BY f.kickoff_utc DESC LIMIT ?`).all(teamId, teamId, limit);
  const games = rows.map((r) => {
    const home = r.home_team_id === teamId;
    const gf = home ? r.hs : r.as2, ga = home ? r.as2 : r.hs;
    return {
      fixture_id: r.id, day: r.kickoff_utc.slice(0, 10), home,
      opponent: home ? r.away_name : r.home_name, comp: r.comp_name,
      gf, ga, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    };
  });
  const pts = (g) => g.result === 'W' ? 3 : g.result === 'D' ? 1 : 0;
  const last5 = games.slice(0, 5), prev5 = games.slice(5, 10);
  const avg = (arr, fn) => arr.length ? arr.reduce((a, g) => a + fn(g), 0) / arr.length : null;
  const split = (loc) => {
    const g = games.filter((x) => x.home === loc);
    return { n: g.length, gf: avg(g, (x) => x.gf), ga: avg(g, (x) => x.ga),
      w: g.filter((x) => x.result === 'W').length };
  };
  return {
    games,
    momentum: {
      last5_ppg: avg(last5, pts), prev5_ppg: avg(prev5, pts),
      trend: (avg(last5, pts) ?? 0) > (avg(prev5, pts) ?? 0) ? 'UP'
        : (avg(last5, pts) ?? 0) < (avg(prev5, pts) ?? 0) ? 'DOWN' : 'FLAT',
    },
    home: split(true), away: split(false),
    avg_gf: avg(games, (g) => g.gf), avg_ga: avg(games, (g) => g.ga),
  };
}

/** 🧮 Comparateur modèle vs marché : pronostics pré-match en attente disposant
 *  d'une probabilité de marché (cotes réelles), triés par écart absolu. */
export function modelVsMarket({ hours = 48, limit = 60 } = {}) {
  const rows = db.prepare(`SELECT p.id AS prediction_id, p.fixture_id, p.market, p.selection,
      p.probability, p.market_probability, p.odds, p.edge, p.ev, p.decision,
      f.kickoff_utc, c.name AS comp_name, c.code AS comp_code,
      ht.name AS home_name, at2.name AS away_name
      FROM predictions p
      JOIN fixtures f ON f.id=p.fixture_id
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE p.result='PENDING' AND p.market_probability IS NOT NULL
        AND f.status IN ('SCHEDULED','UPCOMING')
        AND f.kickoff_utc BETWEEN datetime('now') AND datetime('now', ?)
      ORDER BY ABS(p.edge) DESC LIMIT ?`).all(`+${hours} hours`, limit);
  return rows
    .filter((r, i, arr) => arr.findIndex((x) => x.fixture_id === r.fixture_id && x.market === r.market) === i)
    .map((r) => ({ ...r, gap: r.market_probability != null ? Math.round((r.probability - r.market_probability) * 10000) / 10000 : null, label: marketLabel(r.market, r.selection) }));
}

/** 📅 Calendrier : nombre de matchs et de pronostics par jour (fenêtre ±7 j). */
export function calendarCounts(daysBack = 7, daysAhead = 7) {
  const rows = db.prepare(`SELECT date(f.kickoff_utc) AS day,
      COUNT(DISTINCT f.id) AS fixtures,
      COUNT(DISTINCT CASE WHEN p.decision IN ('PICK','VALUE BET','ANALYSIS PICK') THEN p.fixture_id END) AS picks
      FROM fixtures f
      LEFT JOIN predictions p ON p.fixture_id=f.id
      WHERE date(f.kickoff_utc) BETWEEN date('now', ?) AND date('now', ?)
      GROUP BY day ORDER BY day`).all(`-${daysBack} days`, `+${daysAhead} days`);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = -daysBack; i <= daysAhead; i++) {
    const day = new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) || { day, fixtures: 0, picks: 0 });
  }
  return out;
}

/** 🔍 « Pourquoi ce pronostic ? » : justification factuelle générée depuis les
 *  données réelles (forme, splits, modèle vs marché) — jamais de texte inventé :
 *  chaque phrase est adossée à un chiffre vérifiable en base. */
export function explainPick(predictionId) {
  const p = db.prepare(`SELECT p.*, f.home_team_id, f.away_team_id, f.kickoff_utc,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id WHERE p.id=?`).get(predictionId);
  if (!p) return null;
  const fh = teamForm(p.home_team_id, 10), fa = teamForm(p.away_team_id, 10);
  const serie = (f) => f.games.slice(0, 5).map((g) => g.result === 'W' ? 'V' : g.result === 'L' ? 'D' : 'N').join('-') || '—';
  const n1 = (x) => x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1);
  const reasons = [];
  reasons.push(`Le modèle donne ${(p.probability * 100).toFixed(0)} % à « ${marketLabel(p.market, p.selection)} » (${p.comp_name}).`);
  reasons.push(`Forme récente — ${p.home_name} : ${serie(fh)} (${n1(fh.momentum.last5_ppg)} pt/match sur les 5 derniers) ; ${p.away_name} : ${serie(fa)} (${n1(fa.momentum.last5_ppg)} pt/match).`);
  if (fh.home.n >= 3) reasons.push(`À domicile, ${p.home_name} marque ${n1(fh.home.gf)} but(s) et encaisse ${n1(fh.home.ga)} par match (${fh.home.w} victoire(s) sur ${fh.home.n}).`);
  if (fa.away.n >= 3) reasons.push(`À l'extérieur, ${p.away_name} marque ${n1(fa.away.gf)} but(s) et encaisse ${n1(fa.away.ga)} par match (${fa.away.w} victoire(s) sur ${fa.away.n}).`);
  if (fh.momentum.trend !== 'FLAT') reasons.push(`Dynamique ${p.home_name} : ${fh.momentum.trend === 'UP' ? 'en hausse 📈' : 'en baisse 📉'} (${n1(fh.momentum.prev5_ppg)} → ${n1(fh.momentum.last5_ppg)} pt/match).`);
  if (fa.momentum.trend !== 'FLAT') reasons.push(`Dynamique ${p.away_name} : ${fa.momentum.trend === 'UP' ? 'en hausse 📈' : 'en baisse 📉'} (${n1(fa.momentum.prev5_ppg)} → ${n1(fa.momentum.last5_ppg)} pt/match).`);
  if (p.market_probability != null) {
    const diff = (p.probability - p.market_probability) * 100;
    reasons.push(diff > 0
      ? `Le marché n'estime cette issue qu'à ${(p.market_probability * 100).toFixed(0)} % : le modèle voit ${diff.toFixed(1)} point(s) de valeur en plus (cote ${p.odds}).`
      : `Le marché estime cette issue à ${(p.market_probability * 100).toFixed(0)} % — pronostic retenu pour sa probabilité, pas pour sa valeur (écart ${diff.toFixed(1)} pt).`);
  } else if (p.decision === 'ANALYSIS PICK') {
    reasons.push(`Aucune cote bookmaker disponible : pronostic d'analyse pure, cote équitable ${p.fair_odds ?? p.odds} (= 1/probabilité).`);
  }
  if (p.data_quality != null) reasons.push(`Qualité des données de ce match : ${(p.data_quality * 100).toFixed(0)} % (sources, profondeur d'historique, cotes).`);
  return {
    prediction_id: p.id, fixture_id: p.fixture_id,
    market: p.market, selection: p.selection, label: marketLabel(p.market, p.selection),
    decision: p.decision, probability: p.probability,
    reasons,
    tag: 'CALCULATED DATA — chaque affirmation provient des matchs réels en base.',
  };
}

/** 🧾 Archives des sélections quotidiennes (Expert / Combiné) avec résultats. */
export function selectionsHistory(type = null, limit = 30) {
  const rows = type
    ? db.prepare(`SELECT * FROM daily_selections WHERE type=? ORDER BY day DESC LIMIT ?`).all(type, limit)
    : db.prepare(`SELECT * FROM daily_selections ORDER BY day DESC, type LIMIT ?`).all(limit * 2);
  return rows.map((r) => ({
    day: r.day, type: r.type, status: r.status,
    combined_odds: r.combined_odds, combined_probability: r.combined_probability,
    legs: JSON.parse(r.legs_json || '[]'),
  }));
}

/* ==================== v3.6 ==================== */

/** 🎯 Scores exacts les plus probables — matrice de Poisson issue des lambdas
 *  RÉELLEMENT calculés par le modèle pour ce match (model_outputs).
 *  MODEL ESTIMATE : aucune invention, la matrice découle des forces ajustées. */
export function scorelines(fixtureId, top = 6) {
  const mo = db.prepare(`SELECT lambda_home, lambda_away, model_name, computed_at
      FROM model_outputs WHERE fixture_id=? AND lambda_home IS NOT NULL
      ORDER BY computed_at DESC LIMIT 1`).get(fixtureId);
  if (!mo) return null;
  const M = scoreMatrix(mo.lambda_home, mo.lambda_away, 0);
  const list = [];
  for (let h = 0; h < M.length; h++) for (let a = 0; a < M[h].length; a++) {
    list.push({ score: `${h}-${a}`, home: h, away: a, p: M[h][a] });
  }
  list.sort((x, y) => y.p - x.p);
  const kept = list.slice(0, top).map((s) => ({ ...s, p: round4(s.p) }));
  const covered = kept.reduce((acc, s) => acc + s.p, 0);
  return {
    lambdas: { home: round2(mo.lambda_home), away: round2(mo.lambda_away) },
    model: mo.model_name, computed_at: mo.computed_at,
    scores: kept,
    others_p: round4(Math.max(0, 1 - covered)),
    tag: 'MODEL ESTIMATE — matrice de Poisson sur les buts attendus du modèle.',
  };
}

/** 📈 Trajectoire Elo d'une équipe : rejoue chronologiquement les matchs réels
 *  de sa compétition principale avec le même moteur Elo que la production. */
export function eloHistory(teamId, points = 40) {
  const comp = db.prepare(`SELECT competition_id AS id, COUNT(*) AS n FROM fixtures
      WHERE (home_team_id=? OR away_team_id=?) AND status='FINISHED' AND home_score IS NOT NULL
      GROUP BY competition_id ORDER BY n DESC LIMIT 1`).get(teamId, teamId);
  if (!comp) return null;
  const matches = db.prepare(`SELECT home_team_id AS h, away_team_id AS a,
      home_score AS hs, away_score AS as2, kickoff_utc AS ts FROM fixtures
      WHERE competition_id=? AND status='FINISHED' AND home_score IS NOT NULL
      ORDER BY kickoff_utc ASC`).all(comp.id);
  const ratings = new Map();
  const hist = [];
  for (const m of matches) {
    updateElo(ratings, m.h, m.a, m.hs, m.as2);
    if (m.h === teamId || m.a === teamId) {
      hist.push({ day: m.ts.slice(0, 10), rating: Math.round(ratings.get(teamId) ?? ELO_START) });
    }
  }
  const compName = db.prepare(`SELECT name FROM competitions WHERE id=?`).get(comp.id)?.name || null;
  return {
    competition: compName, total_matches: hist.length,
    current: hist.length ? hist[hist.length - 1].rating : ELO_START,
    points: hist.slice(-points),
    tag: 'CALCULATED DATA — Elo rejoué sur les résultats réels de la compétition.',
  };
}

/** 🧪 Rapport de backtest : métriques walk-forward persistées à l'entraînement
 *  (Brier, log-loss, poids, calibration, ROI value sur cotes réelles). */
export function backtestReport() {
  const rows = db.prepare(`SELECT * FROM model_versions WHERE version LIKE ?
      ORDER BY training_matches DESC`).all(`${CONFIG.modelVersion}-comp%`);
  const parsed = rows.map((r) => {
    const compId = parseInt((r.version.match(/-comp(\d+)$/) || [])[1], 10);
    const comp = Number.isFinite(compId)
      ? db.prepare(`SELECT name, code FROM competitions WHERE id=?`).get(compId) : null;
    if (!comp) return null;
    const j = (s) => { try { return JSON.parse(s); } catch { return null; } };
    return {
      competition: comp.name, code: comp.code, trained_at: r.trained_at,
      matches: r.training_matches, brier: r.backtest_brier, logloss: r.backtest_logloss,
      weights: j(r.weights), calibration: j(r.calibration_json), value: j(r.value_json),
    };
  }).filter(Boolean);

  // Calibration globale : agrégation pondérée des bins de toutes les compétitions
  const bins = Array.from({ length: 10 }, (_, i) => ({ bin: `${i * 10}-${(i + 1) * 10}%`, n: 0, pSum: 0, oSum: 0 }));
  for (const c of parsed) {
    (c.calibration || []).forEach((b, i) => {
      if (b && b.n) { bins[i].n += b.n; bins[i].pSum += b.predicted * b.n; bins[i].oSum += b.observed * b.n; }
    });
  }
  const calibration = bins.map((b) => ({
    bin: b.bin, n: b.n,
    predicted: b.n ? round4(b.pSum / b.n) : null,
    observed: b.n ? round4(b.oSum / b.n) : null,
  }));
  let brierN = 0, brierSum = 0;
  for (const c of parsed) if (c.brier != null && c.matches) { brierN += c.matches; brierSum += c.brier * c.matches; }

  // Value global : somme des backtests par compétition
  const withValue = parsed.filter((c) => c.value);
  const global = withValue.length ? {
    bets: withValue.reduce((a, c) => a + c.value.bets, 0),
    wins: withValue.reduce((a, c) => a + c.value.wins, 0),
    profit: round2(withValue.reduce((a, c) => a + c.value.profit, 0)),
  } : null;
  if (global) {
    global.hit_rate = round4(global.wins / global.bets);
    global.roi = round4(global.profit / global.bets);
  }
  return {
    competitions: parsed, calibration,
    global_brier: brierN ? round4(brierSum / brierN) : null,
    value_global: global,
    method: 'Walk-forward strict : chaque match de test est prédit uniquement avec les matchs antérieurs. ROI value simulé à mise fixe 1 u. sur les meilleures cotes réelles historiques (football-data.co.uk). Un pari est simulé quand p×cote−1 ≥ ' + (CONFIG.value.minEdge * 100).toFixed(0) + ' %.',
  };
}
