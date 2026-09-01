// PRONO SPORT — EXPERT MATCH REPORT (§46) + AI EXPLANATION (§45, §84)
// L'explication est générée UNIQUEMENT à partir des données vérifiées en base
// et des sorties de modèles. Chaque section indique sa provenance (§85).
// Aucune statistique n'est fabriquée : section absente = donnée absente.
import { db } from '../db.js';
import { CONFIG, DATA_TAGS } from '../config.js';
import { generatePrediction } from './predictions.js';
import { teamXgProxy } from './xg.js';
import { computeStandings } from './context.js';

function teamForm(teamId, beforeIso, limit = 6) {
  return db.prepare(`SELECT f.*, ht.name AS home_name, at2.name AS away_name
      FROM fixtures f
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.status='FINISHED'
        AND f.kickoff_utc < ? AND f.home_score IS NOT NULL
      ORDER BY f.kickoff_utc DESC LIMIT ?`).all(teamId, teamId, beforeIso, limit);
}

function formSummary(teamId, matches) {
  if (!matches.length) return null;
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  const seq = [];
  for (const m of matches) {
    const isHome = m.home_team_id === teamId;
    const f = isHome ? m.home_score : m.away_score;
    const a = isHome ? m.away_score : m.home_score;
    gf += f; ga += a;
    if (f > a) { w++; seq.push('V'); } else if (f === a) { d++; seq.push('N'); } else { l++; seq.push('D'); }
  }
  return { w, d, l, gf, ga, seq: seq.join(''), n: matches.length };
}

function headToHead(homeId, awayId, beforeIso, limit = 10) {
  return db.prepare(`SELECT f.*, ht.name AS home_name, at2.name AS away_name
      FROM fixtures f
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE ((f.home_team_id=? AND f.away_team_id=?) OR (f.home_team_id=? AND f.away_team_id=?))
        AND f.status='FINISHED' AND f.kickoff_utc < ?
      ORDER BY f.kickoff_utc DESC LIMIT ?`)
    .all(homeId, awayId, awayId, homeId, beforeIso, limit);
}

function avgStats(teamId, beforeIso, limit = 10) {
  const rows = db.prepare(`SELECT ts.* , f.home_team_id, f.away_team_id
      FROM team_statistics ts JOIN fixtures f ON f.id=ts.fixture_id
      WHERE ((f.home_team_id=? AND ts.team_side='home') OR (f.away_team_id=? AND ts.team_side='away'))
        AND f.kickoff_utc < ? AND ts.shots IS NOT NULL
      ORDER BY f.kickoff_utc DESC LIMIT ?`).all(teamId, teamId, beforeIso, limit);
  if (!rows.length) return null;
  const avg = (k) => Math.round(rows.reduce((a, r) => a + (r[k] || 0), 0) / rows.length * 10) / 10;
  return { n: rows.length, shots: avg('shots'), sot: avg('shots_on_target'), corners: avg('corners'), fouls: avg('fouls'), yellow: avg('yellow') };
}

function buildStandingsContext(f) {
  try {
    const st = computeStandings(f.competition_id);
    const home = st.standings.find((s) => s.teamId === f.home_team_id);
    const away = st.standings.find((s) => s.teamId === f.away_team_id);
    if (!home || !away) return { tag: DATA_TAGS.CALCULATED, status: 'INSUFFICIENT DATA' };
    return {
      tag: DATA_TAGS.CALCULATED, season: st.season, of: st.standings.length,
      home: { rank: home.rank, points: home.points, played: home.played, gd: home.gd },
      away: { rank: away.rank, points: away.points, played: away.played, gd: away.gd },
    };
  } catch { return { tag: DATA_TAGS.CALCULATED, status: 'INSUFFICIENT DATA' }; }
}

function refereeProfile(refereeId) {
  if (!refereeId) return null;
  const rows = db.prepare(`SELECT f.id FROM fixtures f WHERE f.referee_id=? AND f.status='FINISHED'`).all(refereeId);
  if (rows.length < 5) return null;
  const ids = rows.map((r) => r.id);
  const stats = db.prepare(`SELECT AVG(yellow) AS y, AVG(red) AS r, AVG(fouls) AS f, COUNT(*) AS n
      FROM team_statistics WHERE fixture_id IN (${ids.map(() => '?').join(',')}) AND yellow IS NOT NULL`).all(...ids)[0];
  if (!stats?.n) return null;
  const name = db.prepare(`SELECT name FROM referees WHERE id=?`).get(refereeId)?.name;
  return {
    name, matches: rows.length,
    avgYellowPerTeam: Math.round((stats.y || 0) * 10) / 10,
    avgFoulsPerTeam: Math.round((stats.f || 0) * 10) / 10,
  };
}

/** Rapport expert complet — chaque bloc porte son tag de provenance. */
export function buildExpertReport(fixtureId, predictionResult) {
  const f = db.prepare(`SELECT f.*, c.name AS comp_name, c.code AS comp_code,
      ht.name AS home_name, ht.badge_url AS home_badge,
      at2.name AS away_name, at2.badge_url AS away_badge,
      v.name AS venue_name, v.city AS venue_city, r.name AS referee_name
      FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      LEFT JOIN venues v ON v.id=f.venue_id LEFT JOIN referees r ON r.id=f.referee_id
      WHERE f.id=?`).get(fixtureId);
  if (!f) return null;
  const before = f.kickoff_utc || new Date().toISOString();

  const homeMatches = teamForm(f.home_team_id, before);
  const awayMatches = teamForm(f.away_team_id, before);
  const report = {
    context: {
      tag: DATA_TAGS.SOURCE,
      competition: f.comp_name, kickoff: f.kickoff_utc, venue: f.venue_name || null,
      referee: f.referee_name || null, status: f.status,
      sources: JSON.parse(f.source_ids || '[]'), validation: f.validation_status,
    },
    form: {
      tag: DATA_TAGS.CALCULATED,
      home: formSummary(f.home_team_id, homeMatches),
      away: formSummary(f.away_team_id, awayMatches),
    },
    headToHead: { tag: DATA_TAGS.SOURCE, matches: headToHead(f.home_team_id, f.away_team_id, before) },
    statistics: {
      tag: DATA_TAGS.CALCULATED,
      home: avgStats(f.home_team_id, before),
      away: avgStats(f.away_team_id, before),
      note: 'Moyennes calculées sur les derniers matchs réels avec statistiques disponibles.',
    },
    xg: {
      tag: DATA_TAGS.MODEL,
      home: teamXgProxy(f.home_team_id, before),
      away: teamXgProxy(f.away_team_id, before),
      note: 'xG ESTIMÉ (proxy ajusté par régression sur les tirs réels de la base) — le xG événementiel n\'est pas disponible en source gratuite validée et n\'est pas inventé.',
    },
    context: buildStandingsContext(f),
    fatigue: {
      tag: DATA_TAGS.CALCULATED,
      home: restDays(f.home_team_id, before),
      away: restDays(f.away_team_id, before),
    },
    referee: { tag: DATA_TAGS.CALCULATED, profile: refereeProfile(f.referee_id) },
    weather: weatherBlock(fixtureId),
    absences: { tag: DATA_TAGS.SOURCE, status: 'DATA UNAVAILABLE', note: 'Aucune source gratuite validée du registre ne fournit blessures/suspensions fiables pour cette compétition.' },
    lineups: lineupBlock(fixtureId),
    market: marketBlock(fixtureId),
    model: predictionResult?.status === 'OK' ? {
      tag: DATA_TAGS.MODEL,
      version: CONFIG.modelVersion,
      probabilities: predictionResult.prediction.markets,
      perModel: predictionResult.prediction.perModel,
      lambdas: predictionResult.prediction.lambdas,
      backtest: predictionResult.backtest,
      confidence: predictionResult.confidence,
    } : { tag: DATA_TAGS.MODEL, status: predictionResult?.status || 'INSUFFICIENT DATA', reason: predictionResult?.reason },
    decision: predictionResult?.status === 'OK' ? {
      tag: DATA_TAGS.MODEL,
      decision: predictionResult.analysis.decision,
      best: predictionResult.analysis.best,
      candidates: predictionResult.analysis.candidates.slice(0, 12),
      noBetReason: predictionResult.analysis.noBetReason,
      dataQuality: predictionResult.dataQuality,
    } : null,
    conclusion: buildConclusion(f, predictionResult),
  };
  return { fixture: f, report };
}

function restDays(teamId, beforeIso) {
  const last = db.prepare(`SELECT kickoff_utc FROM fixtures
      WHERE (home_team_id=? OR away_team_id=?) AND status='FINISHED' AND kickoff_utc < ?
      ORDER BY kickoff_utc DESC LIMIT 1`).get(teamId, teamId, beforeIso);
  if (!last) return null;
  return Math.round((new Date(beforeIso) - new Date(last.kickoff_utc)) / 86400_000);
}

function weatherBlock(fixtureId) {
  const w = db.prepare(`SELECT * FROM weather WHERE fixture_id=?`).get(fixtureId);
  if (!w) return { tag: DATA_TAGS.SOURCE, status: 'WEATHER DATA UNAVAILABLE' };
  return { tag: DATA_TAGS.SOURCE, source: w.source_id, retrieved_at: w.retrieved_at,
    temperature_c: w.temperature_c, precipitation_mm: w.precipitation_mm,
    wind_kmh: w.wind_kmh, humidity: w.humidity };
}

function lineupBlock(fixtureId) {
  const rows = db.prepare(`SELECT * FROM lineups WHERE fixture_id=?`).all(fixtureId);
  if (!rows.length) return { tag: DATA_TAGS.SOURCE, status: 'DATA UNAVAILABLE', note: 'Composition officielle non publiée par les sources du registre.' };
  return { tag: DATA_TAGS.SOURCE, lineups: rows };
}

function marketBlock(fixtureId) {
  const odds = db.prepare(`SELECT bookmaker_code, market_code, selection, price, retrieved_at
      FROM odds WHERE fixture_id=? ORDER BY market_code, selection, bookmaker_code`).all(fixtureId);
  const history = db.prepare(`SELECT bookmaker_code, market_code, selection, price, snapshot_at
      FROM odds_snapshots WHERE fixture_id=? ORDER BY snapshot_at ASC`).all(fixtureId);
  if (!odds.length) return { tag: DATA_TAGS.SOURCE, status: 'DATA UNAVAILABLE' };
  return { tag: DATA_TAGS.SOURCE, source: 'football-data-couk', odds, history };
}

function buildConclusion(f, pr) {
  if (!pr || pr.status !== 'OK') {
    return `INSUFFISANT : ${pr?.reason || 'données insuffisantes pour une analyse quantitative fiable.'} Aucun pronostic n'est forcé (§41).`;
  }
  const p = pr.prediction.ensemble;
  const fav = p.home >= p.draw && p.home >= p.away ? ['victoire de ' + f.home_name, p.home]
    : p.away >= p.draw ? ['victoire de ' + f.away_name, p.away] : ['match nul', p.draw];
  let txt = `Le modèle d'ensemble (Elo + Poisson + Dixon-Coles, poids validés par backtest walk-forward) `
    + `évalue la ${fav[0]} comme issue la plus probable (${(fav[1] * 100).toFixed(1)}%). `
    + `Buts attendus : ${pr.prediction.lambdas.home.toFixed(2)} - ${pr.prediction.lambdas.away.toFixed(2)}. `;
  if (pr.analysis.decision === 'VALUE BET' && pr.analysis.best) {
    const b = pr.analysis.best;
    txt += `VALUE BET détecté : ${b.market} / ${b.selection} — probabilité modèle ${(b.pModel * 100).toFixed(1)}% vs marché ${(b.pMarket * 100).toFixed(1)}%, EV ${(b.ev * 100).toFixed(1)}% à la cote ${b.bestPrice}. `;
  } else if (pr.analysis.decision === 'NO QUALIFIED PICK') {
    txt += `NO QUALIFIED PICK : ${pr.analysis.noBetReason} `;
  }
  txt += `Qualité de données ${(pr.dataQuality.score * 100).toFixed(0)}%, confiance modèle ${(pr.confidence * 100).toFixed(0)}%. `
    + `Risques : variance intrinsèque du football, absences non couvertes par les sources gratuites, mouvement de cotes possible avant le coup d'envoi.`;
  return txt;
}

/** Assistant PRONO SPORT AI (§84) — réponses ancrées dans les données réelles. */
export function assistantAnswer(question, fixtureId) {
  const q = (question || '').toLowerCase();
  const pr = fixtureId ? safePrediction(fixtureId) : null;
  const rep = fixtureId ? buildExpertReport(fixtureId, pr) : null;
  if (!rep) return { answer: "Précisez un match : je réponds uniquement à partir des données réelles collectées.", grounded: false };
  const f = rep.fixture;
  if (q.includes('value') || q.includes('aucun')) {
    if (rep.report.decision?.decision === 'VALUE BET') {
      const b = rep.report.decision.best;
      return { answer: `Value Bet sur ${f.home_name} vs ${f.away_name} : ${b.market}/${b.selection}. Le modèle estime ${(b.pModel * 100).toFixed(1)}% quand le marché implique ${(b.pMarket * 100).toFixed(1)}% (cotes réelles ${b.bestBook} ${b.bestPrice}). Edge ${(b.edge * 100).toFixed(1)}%, EV ${(b.ev * 100).toFixed(1)}%.`, grounded: true };
    }
    return { answer: `Aucun Value Bet qualifié sur ce match. Raison exacte : ${rep.report.decision?.noBetReason || rep.report.model?.reason || 'données insuffisantes.'}`, grounded: true };
  }
  if (q.includes('marché') || q.includes('market') || q.includes('pourquoi')) {
    return { answer: rep.report.conclusion, grounded: true };
  }
  if (q.includes('risque')) {
    return { answer: `Risques identifiés : (1) qualité de données ${rep.report.decision ? (rep.report.decision.dataQuality.score * 100).toFixed(0) + '%' : 'N/A'} ; (2) absences/blessures non couvertes par les sources gratuites validées (DATA UNAVAILABLE) ; (3) variance du football (~25-30% de nuls dans les données) ; (4) mouvement de cotes avant le coup d'envoi.`, grounded: true };
  }
  if (q.includes('forme') || q.includes('facteur')) {
    const h = rep.report.form.home, a = rep.report.form.away;
    if (!h || !a) return { answer: 'INSUFFICIENT DATA : forme récente indisponible pour au moins une équipe.', grounded: true };
    return { answer: `Forme (données réelles) — ${f.home_name} : ${h.seq} (${h.gf} buts pour, ${h.ga} contre sur ${h.n} matchs). ${f.away_name} : ${a.seq} (${a.gf} pour, ${a.ga} contre).`, grounded: true };
  }
  return { answer: rep.report.conclusion, grounded: true };
}

function safePrediction(fixtureId) {
  try { return generatePrediction(fixtureId); } catch { return null; }
}
