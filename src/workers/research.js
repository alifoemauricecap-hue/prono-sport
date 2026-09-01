// PRONO SPORT — MOTEUR DE RECHERCHE CIBLÉE (Deep Research Engine)
// Problème résolu : un match programmé affiche « pas assez de données » alors
// que l'historique de la compétition EXISTE en ligne sur d'autres sources.
// Ce worker détecte automatiquement ces matchs, identifie la source capable de
// combler le trou (ESPN, TheSportsDB), reconstitue l'historique RÉEL de la
// compétition, puis relance la génération de pronostics.
// RÈGLE ABSOLUE respectée : uniquement des résultats officiels récupérés en
// ligne (SOURCE DATA) — jamais de données inventées. Si aucune source ne
// couvre la compétition, le match reste honnêtement en « données insuffisantes ».
import { db, now, logJob } from '../db.js';
import { CONFIG } from '../config.js';
import { findEspnLeagueForCompetition, syncEspnHistory } from '../providers/espn.js';

const RETRY_HOURS = 6;         // pas de nouvelle recherche sur une comp avant 6 h
const MAX_COMPS_PER_RUN = 2;   // borné : politesse envers les sources + CPU limité
const MIN_COMP_MATCHES = 60;   // seuil d'entraînement d'un modèle de compétition

function kvGet(key) {
  return db.prepare(`SELECT value FROM kv WHERE key=?`).get(key)?.value || null;
}
function kvSet(key, value) {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

/**
 * Détecte les compétitions ayant des matchs programmés (7 prochains jours)
 * mais un historique insuffisant pour produire un pronostic :
 * - moins de 60 matchs terminés dans la compétition, OU
 * - une équipe concernée avec moins de minMatchesPerTeam matchs terminés.
 */
export function findDataPoorCompetitions() {
  const comps = db.prepare(`
    SELECT c.id, c.code, c.name, co.name AS country, COUNT(f.id) AS upcoming
    FROM fixtures f
    JOIN competitions c ON c.id = f.competition_id
    LEFT JOIN countries co ON co.id = c.country_id
    WHERE f.status IN ('SCHEDULED','UPCOMING')
      AND f.kickoff_utc BETWEEN datetime('now') AND datetime('now','+7 day')
    GROUP BY c.id`).all();

  const poor = [];
  for (const c of comps) {
    const finished = db.prepare(`SELECT COUNT(*) AS n FROM fixtures
        WHERE competition_id=? AND status='FINISHED'
        AND home_score IS NOT NULL`).get(c.id).n;
    let reason = null;
    if (finished < MIN_COMP_MATCHES) {
      reason = `historique compétition insuffisant (${finished}/${MIN_COMP_MATCHES})`;
    } else {
      // profondeur par équipe sur les matchs à venir
      const weak = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT f.id,
            (SELECT COUNT(*) FROM fixtures h WHERE h.competition_id=f.competition_id
              AND h.status='FINISHED' AND (h.home_team_id=f.home_team_id OR h.away_team_id=f.home_team_id)) AS nh,
            (SELECT COUNT(*) FROM fixtures h WHERE h.competition_id=f.competition_id
              AND h.status='FINISHED' AND (h.home_team_id=f.away_team_id OR h.away_team_id=f.away_team_id)) AS na
          FROM fixtures f
          WHERE f.competition_id=? AND f.status IN ('SCHEDULED','UPCOMING')
            AND f.kickoff_utc BETWEEN datetime('now') AND datetime('now','+7 day')
        ) WHERE nh < ? OR na < ?`)
        .get(c.id, CONFIG.value.minMatchesPerTeam, CONFIG.value.minMatchesPerTeam).n;
      if (weak > 0) reason = `${weak} match(s) avec équipe(s) sous ${CONFIG.value.minMatchesPerTeam} matchs d'historique`;
    }
    if (reason) poor.push({ ...c, finished, reason });
  }
  // priorité aux compétitions avec le plus de matchs à venir non couverts
  return poor.sort((a, b) => b.upcoming - a.upcoming);
}

/**
 * Passe de recherche ciblée : pour chaque compétition en manque de données,
 * cherche une source en ligne capable de combler le trou et l'ingère.
 * @returns résumé { examined, researched, ingested, skipped }
 */
export async function runTargetedResearch({ regenerate } = {}) {
  const job = logJob('research.targeted', 'espn');
  const poor = findDataPoorCompetitions();
  let researched = 0, ingested = 0;
  const details = [];
  try {
    for (const comp of poor) {
      if (researched >= MAX_COMPS_PER_RUN) break;
      const lastTry = kvGet(`research_last_${comp.id}`);
      if (lastTry && Date.now() - Number(lastTry) < RETRY_HOURS * 3_600_000) continue;

      const espn = findEspnLeagueForCompetition(comp.name, comp.country);
      if (!espn) {
        // Honnêteté : aucune source gratuite vérifiée ne couvre cette compétition.
        details.push(`${comp.name}: aucune source de recherche disponible`);
        kvSet(`research_last_${comp.id}`, Date.now());
        continue;
      }
      console.log(`[PRONO SPORT] Recherche ciblée : ${comp.name} (${comp.reason}) → ESPN ${espn.slug}`);
      kvSet(`research_last_${comp.id}`, Date.now());
      const r = await syncEspnHistory(espn.slug, comp.id, espn.country, 760);
      researched++;
      ingested += r.total;
      details.push(`${comp.name}: +${r.total} matchs (${r.finished} terminés) via ESPN${r.errors.length ? ` ; ${r.errors.length} erreur(s)` : ''}`);
    }
    if (researched > 0 && typeof regenerate === 'function') await regenerate();
    job.finish('COMPLETED', ingested, details.length ? details.join(' | ') : null);
  } catch (e) {
    job.finish('FAILED', ingested, e.message);
  }
  return { examined: poor.length, researched, ingested, details };
}
