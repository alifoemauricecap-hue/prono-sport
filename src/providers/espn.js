// PRONO SPORT — Adapter ESPN (FootballDataProvider secondaire)
// Source : API JSON publique de ESPN (site.api.espn.com), accessible sans clé.
// Testée réellement le 2026-09-01 : 33 compétitions mappées, ~150-560 matchs/an
// et par ligue, scores finaux + statuts live + stades + logos — SOURCE DATA.
// Usage poli : ≥1,2 s entre requêtes, cache HTTP, jamais de contournement (§5).
// Rôles : (1) couverture des ligues sans CSV (Saudi Pro League, A-League,
// Afrique du Sud, UCL/UEL/Libertadores…) ; (2) validation croisée des scores
// (§6) ; (3) cible du DEEP RESEARCH ENGINE quand un match manque de données.
import { fetchJson } from '../util/http.js';
import { CONFIG } from '../config.js';
import { db } from '../db.js';
import { normalizeTeamName } from '../util/teamNames.js';
import { upsertCompetition, upsertTeam, upsertVenue, upsertFixture } from './repository.js';

const SOURCE_ID = 'espn';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const GAP_MS = 1200;
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeJson(url, ttlMs) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fetchJson(url, { sourceId: SOURCE_ID, ttlMs });
}

/** Toutes les compétitions configurées disposant d'un slug ESPN vérifié. */
export function espnComps() {
  const out = {};
  for (const [code, meta] of Object.entries(CONFIG.divisions || {})) if (meta.espn) out[code] = meta;
  for (const [code, meta] of Object.entries(CONFIG.extraLeagues || {})) if (meta.espn) out[code] = meta;
  return out;
}

/** Mapping des statuts ESPN → statuts internes. Jamais LIVE sans confirmation source (§12). */
export function mapEspnStatus(status) {
  const name = status?.type?.name || '';
  const state = status?.type?.state || '';
  if (name === 'STATUS_FULL_TIME' || name === 'STATUS_FINAL' || status?.type?.completed) return 'FINISHED';
  if (name === 'STATUS_HALFTIME') return 'HALFTIME';
  if (state === 'in') return 'LIVE';
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_ABANDONED') return 'CANCELLED';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

/** Compétitions internationales : résolution d'équipe par nom, tous pays confondus,
 *  pour fusionner « Real Madrid » (UCL) avec « Real Madrid » (La Liga). */
function looseTeamId(name, logo) {
  const norm = normalizeTeamName(name);
  if (!norm) return null;
  const rows = db.prepare(`SELECT id FROM teams WHERE normalized_name=? ORDER BY id ASC`).all(norm);
  if (rows.length >= 1) return rows[0].id;
  return upsertTeam(name, null, { badge_url: logo || null });
}

/** Ingestion d'un événement ESPN dans une compétition mappée. */
export function ingestEspnEvent(ev, code, meta) {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
  const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
  if (!home?.team?.displayName || !away?.team?.displayName) return null;
  const competitionId = upsertCompetition(code, meta.name, meta.country);
  const teamId = (c) => (meta.international
    ? looseTeamId(c.team.displayName, c.team.logo)
    : upsertTeam(c.team.displayName, meta.country, {
      badge_url: c.team.logo || null,
      externalId: { source: SOURCE_ID, id: c.team.id },
    }));
  const homeId = teamId(home);
  const awayId = teamId(away);
  if (!homeId || !awayId) return null;
  if (!ev.date) return null;
  const kickoff = new Date(ev.date).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const status = mapEspnStatus(ev.status);
  // les scores ESPN valent "0" par défaut AVANT le coup d'envoi : on ne les
  // enregistre que pour un match commencé ou terminé (règle anti-donnée-fictive)
  const started = status === 'FINISHED' || status === 'LIVE' || status === 'HALFTIME';
  const num = (v) => (started && v != null && v !== '' ? parseInt(v, 10) : null);
  const venueId = comp.venue?.fullName
    ? upsertVenue(comp.venue.fullName, comp.venue.address?.city || null, meta.country)
    : null;
  const { id } = upsertFixture({
    competitionId,
    seasonCode: ev.season?.year ? String(ev.season.year) : null,
    homeTeamId: homeId,
    awayTeamId: awayId,
    kickoffUtc: kickoff,
    status,
    homeScore: num(home.score),
    awayScore: num(away.score),
    venueId,
    round: comp.status?.type?.description === 'Full Time' ? null : (ev.week?.number ? `J${ev.week.number}` : null),
    sourceId: SOURCE_ID,
    externalId: ev.id,
  });
  return id;
}

/** Synchronise une compétition sur une ou plusieurs années civiles.
 *  1 requête = 1 année complète (calendrier + résultats + matchs en cours). */
export async function syncLeagueYears(code, years, ttlMs = 6 * 3600_000) {
  const meta = espnComps()[code];
  if (!meta) return 0;
  let n = 0;
  for (const year of years) {
    const { data } = await politeJson(`${BASE}/${meta.espn}/scoreboard?dates=${year}&limit=1000`, ttlMs);
    // logo officiel de la compétition (SOURCE DATA) — capté au passage
    const leagueLogo = data?.leagues?.[0]?.logos?.[0]?.href;
    if (leagueLogo) {
      db.prepare(`UPDATE competitions SET logo_url=COALESCE(logo_url, ?) WHERE code=?`).run(leagueLogo, code);
    }
    const events = data?.events || [];
    let i = 0;
    for (const ev of events) {
      if (ingestEspnEvent(ev, code, meta) != null) n++;
      // pause réelle régulière : le healthcheck doit répondre <1 s même à 0,1 CPU
      if (++i % 40 === 0) await sleep(20);
    }
  }
  return n;
}

/** Historique + calendrier complets (année passée + année courante) pour
 *  toutes les compétitions mappées. ~66 requêtes espacées de 1,2 s. */
export async function syncEspnHistory() {
  const comps = espnComps();
  const year = new Date().getUTCFullYear();
  let total = 0;
  const errors = [];
  for (const code of Object.keys(comps)) {
    try {
      total += await syncLeagueYears(code, [year - 1, year]);
    } catch (e) {
      errors.push(`${code}: ${e.message}`);
    }
  }
  return { total, errors };
}

/** Résumé officiel d'un match (recherche ciblée post-match) : buts, cartons,
 *  remplacements — pour le compte rendu du pronostic. */
export async function fetchEventSummary(compCode, espnEventId) {
  const meta = espnComps()[compCode];
  if (!meta) return null;
  const { data } = await politeJson(`${BASE}/${meta.espn}/summary?event=${espnEventId}`, 24 * 3600_000);
  const keyEvents = (data?.keyEvents || []).map((ev) => ({
    kind: ev.type?.text || ev.type?.id || 'événement',
    minute: ev.clock?.displayValue || null,
    text: `${ev.clock?.displayValue ? ev.clock.displayValue + ' ' : ''}${ev.type?.text || ''}${ev.team?.displayName ? ' — ' + ev.team.displayName : ''}${ev.participants?.length ? ' (' + ev.participants.map((p) => p.athlete?.displayName).filter(Boolean).join(', ') + ')' : ''}`.trim(),
  })).filter((e) => e.text);
  return { keyEvents };
}

/** Suivi du jour, CIBLÉ : uniquement les compétitions ayant un match aujourd'hui
 *  (fenêtre -6h/+18h) — met à jour scores, statuts live et coups d'envoi. */
export async function syncEspnToday() {
  const comps = espnComps();
  const active = db.prepare(`SELECT DISTINCT c.code FROM fixtures f
      JOIN competitions c ON c.id = f.competition_id
      WHERE f.kickoff_utc BETWEEN datetime('now', '-6 hours') AND datetime('now', '+18 hours')`)
    .all().map((r) => r.code).filter((code) => comps[code]);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let total = 0;
  const errors = [];
  for (const code of active) {
    try {
      const { data } = await politeJson(`${BASE}/${comps[code].espn}/scoreboard?dates=${today}&limit=100`, 60_000);
      for (const ev of data?.events || []) {
        if (ingestEspnEvent(ev, code, comps[code]) != null) total++;
      }
    } catch (e) {
      errors.push(`${code}: ${e.message}`);
    }
  }
  return { total, errors, leagues: active.length };
}
