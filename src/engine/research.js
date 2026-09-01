// PRONO SPORT — DEEP RESEARCH ENGINE (recherche en ligne ciblée)
// Problème résolu : un match programmé (ex. Saudi Pro League) affichait
// « données insuffisantes » alors que l'historique des équipes EXISTE en ligne.
// Ce moteur détecte chaque lacune de couverture et déclenche des recherches
// web ciblées, source par source, jusqu'à réunir assez de données réelles :
//   1. ESPN : année passée + année courante de la compétition (1 req/an) ;
//   2. TheSportsDB : 5 derniers matchs de CHAQUE équipe encore en déficit
//      (eventslast), toutes compétitions confondues ;
//   3. régénération immédiate des pronostics des matchs concernés.
// Règles : uniquement des sources réelles testées (§2), requêtes espacées,
// arrêt sur rate limit (§5), provenance conservée (§57). Si, après recherche,
// les données restent insuffisantes → l'app affiche toujours l'état honnête.
import { db, now, logJob, notify } from '../db.js';
import { CONFIG } from '../config.js';
import { fetchJson } from '../util/http.js';
import * as espn from '../providers/espn.js';
import { generatePrediction } from './predictions.js';

const TSDB_BASE = () => `https://www.thesportsdb.com/api/v1/json/${CONFIG.theSportsDbKey}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Matchs à venir (≤ horizon) dont une équipe ou la compétition manque
 *  d'historique pour produire un pronostic — les « lacunes de couverture ». */
export function findCoverageGaps(hours = 96, limit = 60) {
  const minTeam = CONFIG.value.minMatchesPerTeam;
  const rows = db.prepare(`
    SELECT f.id, f.competition_id, c.code, f.home_team_id, f.away_team_id, f.kickoff_utc,
      (SELECT COUNT(*) FROM fixtures fh WHERE fh.status='FINISHED'
        AND (fh.home_team_id=f.home_team_id OR fh.away_team_id=f.home_team_id)) AS home_n,
      (SELECT COUNT(*) FROM fixtures fa WHERE fa.status='FINISHED'
        AND (fa.home_team_id=f.away_team_id OR fa.away_team_id=f.away_team_id)) AS away_n,
      (SELECT COUNT(*) FROM fixtures fc WHERE fc.status='FINISHED'
        AND fc.competition_id=f.competition_id) AS comp_n
    FROM fixtures f JOIN competitions c ON c.id=f.competition_id
    WHERE f.status IN ('SCHEDULED','UPCOMING')
      AND f.kickoff_utc BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours')
    ORDER BY f.kickoff_utc ASC LIMIT ?`).all(hours, limit);
  return rows.filter((r) => r.home_n < minTeam || r.away_n < minTeam || r.comp_n < 60);
}

/** Recherche TheSportsDB : 5 derniers matchs réels d'une équipe (toutes comps).
 *  N'ingère que les événements rattachables à une compétition connue —
 *  jamais de compétition fantôme créée par ce chemin. */
async function researchTeamHistory(teamId) {
  const team = db.prepare(`SELECT * FROM teams WHERE id=?`).get(teamId);
  if (!team) return 0;
  const ext = JSON.parse(team.external_ids || '{}');
  const tsdbId = ext.thesportsdb;
  if (!tsdbId) return 0;
  const { data } = await fetchJson(`${TSDB_BASE()}/eventslast.php?id=${tsdbId}`,
    { sourceId: 'thesportsdb', ttlMs: 30 * 60_000 });
  const events = data?.results || data?.events || [];
  let n = 0;
  const { ingestKnownLeagueEvent } = await import('../providers/theSportsDb.js');
  for (const ev of events) {
    if (ingestKnownLeagueEvent(ev) != null) n++;
  }
  await sleep(2000); // tier gratuit : 2 s entre appels
  return n;
}

/**
 * Cycle de recherche approfondie : détecte les lacunes, recherche en ligne,
 * régénère les pronostics. Budget borné par cycle (politesse) : max 4
 * compétitions ESPN + 8 équipes TheSportsDB.
 */
export async function runDeepResearch() {
  const job = logJob('deepResearch', null);
  const gaps = findCoverageGaps();
  if (!gaps.length) {
    job.finish('COMPLETED', 0, null);
    return { gaps: 0, ingested: 0, regenerated: 0 };
  }
  const errors = [];
  let ingested = 0;
  const year = new Date().getUTCFullYear();

  // 1) compétitions en déficit couvertes par ESPN → année passée + courante
  const compCodes = [...new Set(gaps.map((g) => g.code))];
  const espnMapped = compCodes.filter((code) => espn.espnComps()[code]).slice(0, 4);
  for (const code of espnMapped) {
    try {
      ingested += await espn.syncLeagueYears(code, [year - 1, year], 30 * 60_000);
    } catch (e) {
      errors.push(`espn/${code}: ${e.message}`);
      if (String(e.message).includes('429')) break;
    }
  }

  // 2) équipes encore en déficit → 5 derniers matchs via TheSportsDB
  const minTeam = CONFIG.value.minMatchesPerTeam;
  const teamCount = db.prepare(`SELECT COUNT(*) AS n FROM fixtures
      WHERE status='FINISHED' AND (home_team_id=? OR away_team_id=?)`);
  const shortTeams = [...new Set(gaps.flatMap((g) => [g.home_team_id, g.away_team_id]))]
    .filter((tid) => teamCount.get(tid, tid).n < minTeam).slice(0, 8);
  for (const tid of shortTeams) {
    try {
      ingested += await researchTeamHistory(tid);
    } catch (e) {
      errors.push(`tsdb/team${tid}: ${e.message}`);
      if (String(e.message).includes('429')) break;
    }
  }

  // 3) régénération des pronostics des matchs concernés (garde §34 respectée
  //    par generatePrediction : un pronostic publié n'est jamais réécrit)
  let regenerated = 0;
  for (const g of gaps) {
    try {
      const r = generatePrediction(g.id);
      if (r?.status === 'OK') regenerated++;
    } catch { /* état honnête conservé */ }
    await new Promise((r) => setTimeout(r, 15)); // vraie pause : healthcheck réactif
  }

  job.finish(errors.length ? 'PARTIAL' : 'COMPLETED', ingested,
    errors.length ? errors.join('; ') : null);
  if (regenerated > 0) {
    notify('DEEP_RESEARCH', { gaps: gaps.length, ingested, regenerated });
  }
  return { gaps: gaps.length, ingested, regenerated, errors };
}
