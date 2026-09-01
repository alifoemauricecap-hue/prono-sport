// PRONO SPORT — Adapter OpenLigaDB (FootballDataProvider + LIVE)
// Open data allemand : Bundesliga 1/2 avec buts minute par minute — SOURCE DATA.
// C'est la seule source gratuite du registre confirmant réellement l'état LIVE ;
// les événements live ne sont donc affichés QUE pour sa couverture (§16).
import { fetchJson } from '../util/http.js';
import { CONFIG } from '../config.js';
import { db, now } from '../db.js';
import { upsertCompetition, upsertTeam, upsertFixture } from './repository.js';

const SOURCE_ID = 'openligadb';
const BASE = 'https://api.openligadb.de';
const LEAGUES = { bl1: 'D1', bl2: 'D2' }; // shortcut OpenLigaDB → code division interne

function finalScore(m) {
  const end = (m.matchResults || []).find((r) => r.resultTypeID === 2)
    || (m.matchResults || []).find((r) => r.resultTypeKind === 'After90Minutes');
  if (end) return { h: end.pointsTeam1, a: end.pointsTeam2 };
  // score courant à partir des buts (match en cours)
  const goals = m.goals || [];
  if (goals.length) {
    const last = goals[goals.length - 1];
    return { h: last.scoreTeam1, a: last.scoreTeam2 };
  }
  return { h: null, a: null };
}

function mapStatus(m) {
  if (m.matchIsFinished) return 'FINISHED';
  const ko = new Date(m.matchDateTimeUTC);
  const mins = (Date.now() - ko.getTime()) / 60000;
  if (mins < 0) return 'SCHEDULED';
  // La source a confirmé le coup d'envoi passé et le match non terminé.
  if (mins <= 130) return 'LIVE';
  return 'UNKNOWN'; // trop ancien sans statut final → ne pas prétendre live (§11)
}

function ingest(m, divCode) {
  const divMeta = CONFIG.divisions[divCode];
  const competitionId = upsertCompetition(divCode, divMeta.name, divMeta.country);
  const homeId = upsertTeam(m.team1.teamName, divMeta.country, {
    badge_url: m.team1.teamIconUrl || null,
    externalId: { source: SOURCE_ID, id: String(m.team1.teamId) },
  });
  const awayId = upsertTeam(m.team2.teamName, divMeta.country, {
    badge_url: m.team2.teamIconUrl || null,
    externalId: { source: SOURCE_ID, id: String(m.team2.teamId) },
  });
  if (!homeId || !awayId) return null;
  const score = finalScore(m);
  const status = mapStatus(m);
  const ht = (m.matchResults || []).find((r) => r.resultTypeID === 1);
  const { id: fixtureId } = upsertFixture({
    competitionId, seasonCode: null,
    homeTeamId: homeId, awayTeamId: awayId,
    kickoffUtc: new Date(m.matchDateTimeUTC).toISOString(),
    status,
    homeScore: score.h, awayScore: score.a,
    htHome: ht?.pointsTeam1 ?? null, htAway: ht?.pointsTeam2 ?? null,
    round: m.group?.groupName || null,
    sourceId: SOURCE_ID, externalId: String(m.matchID),
  });
  // Événements de buts réels (§16)
  for (const g of m.goals || []) {
    db.prepare(`INSERT OR IGNORE INTO fixture_events
        (fixture_id, minute, type, player_name, team_side, detail, source_id, retrieved_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(fixtureId, g.matchMinute ?? null,
        g.isPenalty ? 'PENALTY_GOAL' : (g.isOwnGoal ? 'OWN_GOAL' : 'GOAL'),
        g.goalGetterName || null,
        g.scoringTeamId === m.team1.teamId ? 'home' : 'away',
        `${g.scoreTeam1}-${g.scoreTeam2}`, SOURCE_ID, now());
  }
  return { fixtureId, status };
}

/** Journée courante (inclut les matchs live) */
export async function syncCurrentMatchday(shortcut) {
  const { data } = await fetchJson(`${BASE}/getmatchdata/${shortcut}`,
    { sourceId: SOURCE_ID, ttlMs: 45_000 });
  const divCode = LEAGUES[shortcut];
  let n = 0, liveCount = 0;
  for (const m of data || []) {
    const r = ingest(m, divCode);
    if (r) { n++; if (r.status === 'LIVE') liveCount++; }
  }
  return { n, liveCount };
}

/** Saison complète (historique + calendrier restant) — ingestion par lots */
export async function syncSeason(shortcut, seasonYear) {
  const { data } = await fetchJson(`${BASE}/getmatchdata/${shortcut}/${seasonYear}`,
    { sourceId: SOURCE_ID, ttlMs: 3600_000 });
  const divCode = LEAGUES[shortcut];
  let n = 0;
  const matches = data || [];
  for (let i = 0; i < matches.length; i += 100) {
    const slice = matches.slice(i, i + 100);
    db.transaction(() => {
      for (const m of slice) if (ingest(m, divCode)) n++;
    })();
    await new Promise((r) => setImmediate(r)); // healthcheck réactif sur petites instances
  }
  return n;
}

export const OPENLIGA_LEAGUES = LEAGUES;
