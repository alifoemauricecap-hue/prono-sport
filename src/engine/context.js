// PRONO SPORT — CONTEXT ENGINE (CALCULATED DATA)
// Classements, splits domicile/extérieur, profil complet par équipe —
// tout est CALCULÉ à partir des résultats réels en base, rien d'inventé.
import { db } from '../db.js';
import { getCompetitionModel } from './predictions.js';
import { teamXgProxy } from './xg.js';
import { ELO_START } from './elo.js';

/** Saison courante d'une compétition = celle du match terminé le plus récent. */
function currentSeasonCode(competitionId) {
  const r = db.prepare(`SELECT season_code FROM fixtures
      WHERE competition_id=? AND status='FINISHED' AND season_code IS NOT NULL
      ORDER BY kickoff_utc DESC LIMIT 1`).get(competitionId);
  return r?.season_code || null;
}

/** Classement calculé (3/1/0) sur les résultats réels de la saison courante. */
export function computeStandings(competitionId) {
  const season = currentSeasonCode(competitionId);
  const rows = season
    ? db.prepare(`SELECT * FROM fixtures WHERE competition_id=? AND status='FINISHED'
        AND season_code=? AND home_score IS NOT NULL`).all(competitionId, season)
    : db.prepare(`SELECT * FROM fixtures WHERE competition_id=? AND status='FINISHED'
        AND home_score IS NOT NULL AND kickoff_utc > datetime('now','-200 days')`).all(competitionId);
  const table = new Map();
  const get = (id) => {
    if (!table.has(id)) table.set(id, { teamId: id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 });
    return table.get(id);
  };
  for (const m of rows) {
    const h = get(m.home_team_id), a = get(m.away_team_id);
    h.played++; a.played++;
    h.gf += m.home_score; h.ga += m.away_score;
    a.gf += m.away_score; a.ga += m.home_score;
    if (m.home_score > m.away_score) { h.won++; h.points += 3; a.lost++; }
    else if (m.home_score < m.away_score) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  const standings = [...table.values()]
    .sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf)
    .map((t, i) => ({ ...t, rank: i + 1, gd: t.gf - t.ga }));
  const names = db.prepare(`SELECT id, name, badge_url FROM teams WHERE id IN (${standings.map(() => '?').join(',') || 'NULL'})`)
    .all(...standings.map((s) => s.teamId));
  const nameMap = new Map(names.map((n) => [n.id, n]));
  return {
    season: season || 'fenêtre 200 jours',
    tag: 'CALCULATED DATA',
    note: 'Classement calculé à partir des résultats réels en base (3/1/0). Les éventuels retraits de points administratifs ne sont pas couverts par les sources gratuites.',
    standings: standings.map((s) => ({ ...s, name: nameMap.get(s.teamId)?.name, badge_url: nameMap.get(s.teamId)?.badge_url })),
  };
}

function splitRecord(teamId, side, limit = 40) {
  const col = side === 'home' ? 'home_team_id' : 'away_team_id';
  const rows = db.prepare(`SELECT home_score, away_score FROM fixtures
      WHERE ${col}=? AND status='FINISHED' AND home_score IS NOT NULL
      ORDER BY kickoff_utc DESC LIMIT ?`).all(teamId, limit);
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of rows) {
    const f = side === 'home' ? m.home_score : m.away_score;
    const a = side === 'home' ? m.away_score : m.home_score;
    gf += f; ga += a;
    if (f > a) w++; else if (f === a) d++; else l++;
  }
  return rows.length ? { played: rows.length, w, d, l, gf, ga } : null;
}

/**
 * DOSSIER COMPLET D'ÉQUIPE — statistiques, contexte, xG-proxy,
 * facteurs internes (forme, fatigue, forces modèle) et externes (calendrier).
 */
export function teamProfile(teamId) {
  const team = db.prepare(`SELECT * FROM teams WHERE id=?`).get(teamId);
  if (!team) return null;
  const nowIso = new Date().toISOString();

  // compétition principale = celle du match le plus récent
  const mainComp = db.prepare(`SELECT c.id, c.code, c.name FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.status='FINISHED'
      ORDER BY f.kickoff_utc DESC LIMIT 1`).get(teamId, teamId);

  // contexte : position au classement calculé
  let context = null;
  if (mainComp) {
    const st = computeStandings(mainComp.id);
    const entry = st.standings.find((s) => s.teamId === teamId);
    if (entry) {
      context = { tag: 'CALCULATED DATA', competition: mainComp.name, season: st.season,
        rank: entry.rank, of: st.standings.length, points: entry.points,
        played: entry.played, gd: entry.gd };
    }
  }

  // facteurs internes : forces du modèle (Elo, attaque/défense)
  let modelFactors = null;
  if (mainComp) {
    const model = getCompetitionModel(mainComp.id);
    if (model) {
      const strengths = model.fit?.teams?.get(teamId);
      modelFactors = {
        tag: 'MODEL ESTIMATE',
        elo: Math.round(model.ratings.get(teamId) ?? ELO_START),
        attackStrength: strengths ? Math.round(strengths.attack * 100) / 100 : null,
        defenseWeakness: strengths ? Math.round(strengths.defense * 100) / 100 : null,
        note: 'Elo et forces relatives estimés sur l\'historique réel de la compétition (1.0 = moyenne de la ligue).',
      };
    }
  }

  // statistiques moyennes réelles (10 derniers matchs avec stats)
  const avgRows = db.prepare(`SELECT ts.* FROM team_statistics ts
      JOIN fixtures f ON f.id=ts.fixture_id
      WHERE ((f.home_team_id=? AND ts.team_side='home') OR (f.away_team_id=? AND ts.team_side='away'))
        AND ts.shots IS NOT NULL ORDER BY f.kickoff_utc DESC LIMIT 10`).all(teamId, teamId);
  const avg = (k) => avgRows.length ? Math.round(avgRows.reduce((s, r) => s + (r[k] || 0), 0) / avgRows.length * 10) / 10 : null;
  const statistics = avgRows.length ? {
    tag: 'CALCULATED DATA', matches: avgRows.length,
    shots: avg('shots'), shotsOnTarget: avg('shots_on_target'),
    corners: avg('corners'), fouls: avg('fouls'), yellow: avg('yellow'), red: avg('red'),
  } : null;

  // fatigue / calendrier (facteur externe calculé)
  const lastMatch = db.prepare(`SELECT kickoff_utc FROM fixtures
      WHERE (home_team_id=? OR away_team_id=?) AND status='FINISHED'
      ORDER BY kickoff_utc DESC LIMIT 1`).get(teamId, teamId);
  const last30 = db.prepare(`SELECT COUNT(*) AS n FROM fixtures
      WHERE (home_team_id=? OR away_team_id=?) AND status='FINISHED'
      AND kickoff_utc > datetime('now','-30 days')`).get(teamId, teamId).n;
  const fatigue = {
    tag: 'CALCULATED DATA',
    restDays: lastMatch ? Math.round((Date.now() - new Date(lastMatch.kickoff_utc).getTime()) / 86400_000) : null,
    matchesLast30Days: last30,
  };

  return {
    team: { ...team, external_ids: JSON.parse(team.external_ids || '{}') },
    competition: mainComp || null,
    context: context || { status: 'INSUFFICIENT DATA' },
    form: {
      tag: 'CALCULATED DATA',
      home: splitRecord(teamId, 'home', 20),
      away: splitRecord(teamId, 'away', 20),
    },
    statistics: statistics || { status: 'DATA UNAVAILABLE', note: 'Stats détaillées non publiées par les sources pour cette compétition.' },
    xgProxy: teamXgProxy(teamId, nowIso) || { status: 'DATA UNAVAILABLE', note: 'Pas assez de matchs avec tirs réels — le proxy xG n\'est pas fabriqué.' },
    modelFactors: modelFactors || { status: 'INSUFFICIENT DATA' },
    fatigue,
    availability: {
      tag: 'SOURCE DATA', status: 'DATA UNAVAILABLE',
      note: 'Blessures/suspensions : aucune source gratuite validée du registre. Rien n\'est inventé (§22).',
    },
  };
}
