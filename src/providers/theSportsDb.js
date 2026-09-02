// PRONO SPORT — Adapter TheSportsDB (FootballDataProvider)
// Fournit : calendriers, résultats, logos d'équipes, stades — SOURCE DATA.
// Utilisé en source secondaire pour la validation croisée des matchs (§6).
import { fetchJson } from '../util/http.js';
import { CONFIG } from '../config.js';
import { db, now, notify } from '../db.js';
import { upsertCompetition, upsertTeam, upsertVenue, upsertFixture } from './repository.js';

const SOURCE_ID = 'thesportsdb';
const BASE = () => `https://www.thesportsdb.com/api/v1/json/${CONFIG.theSportsDbKey}`;

function mapStatus(ev) {
  const s = (ev.strStatus || '').toUpperCase();
  if (['FT', 'MATCH FINISHED', 'AET', 'PEN'].includes(s)) return 'FINISHED';
  if (s === 'HT') return 'HALFTIME';
  if (['1H', '2H', 'LIVE', 'ET', 'IN PLAY'].includes(s)) return 'LIVE';
  if (s === 'POSTPONED' || s === 'POST') return 'POSTPONED';
  if (s === 'CANCELLED' || s === 'CANC') return 'CANCELLED';
  if (ev.intHomeScore != null && ev.intHomeScore !== '') return 'FINISHED';
  const ko = ev.strTimestamp ? new Date(`${ev.strTimestamp}Z`) : null;
  if (ko && ko > new Date()) return 'SCHEDULED';
  return 'UNKNOWN'; // jamais présenté comme LIVE sans confirmation de la source (§12)
}

function ingestEvent(ev, divCode, divMeta) {
  const competitionId = upsertCompetition(divCode, divMeta.name, divMeta.country);
  const homeId = upsertTeam(ev.strHomeTeam, divMeta.country, {
    badge_url: ev.strHomeTeamBadge || null,
    externalId: { source: SOURCE_ID, id: ev.idHomeTeam },
  });
  const awayId = upsertTeam(ev.strAwayTeam, divMeta.country, {
    badge_url: ev.strAwayTeamBadge || null,
    externalId: { source: SOURCE_ID, id: ev.idAwayTeam },
  });
  if (!homeId || !awayId) return null;
  const kickoff = ev.strTimestamp ? `${ev.strTimestamp}Z` : (ev.dateEvent ? `${ev.dateEvent}T${ev.strTime || '15:00:00'}Z` : null);
  if (!kickoff) return null;
  const venueId = ev.strVenue ? upsertVenue(ev.strVenue, ev.strCity || null, ev.strCountry || divMeta.country) : null;
  const hs = ev.intHomeScore !== '' && ev.intHomeScore != null ? parseInt(ev.intHomeScore, 10) : null;
  const as = ev.intAwayScore !== '' && ev.intAwayScore != null ? parseInt(ev.intAwayScore, 10) : null;
  const { id } = upsertFixture({
    competitionId,
    seasonCode: null,
    homeTeamId: homeId, awayTeamId: awayId,
    kickoffUtc: kickoff,
    status: mapStatus(ev),
    homeScore: hs, awayScore: as,
    venueId, round: ev.intRound ? `J${ev.intRound}` : null,
    sourceId: SOURCE_ID, externalId: ev.idEvent,
  });
  return id;
}

/** Prochains matchs d'une ligue (validation croisée + logos + stades) */
export async function syncLeagueUpcoming(divCode) {
  const divMeta = CONFIG.divisions[divCode];
  if (!divMeta?.tsdbLeagueId) return 0;
  const { data } = await fetchJson(`${BASE()}/eventsnextleague.php?id=${divMeta.tsdbLeagueId}`,
    { sourceId: SOURCE_ID, ttlMs: 10 * 60_000 });
  const events = data?.events || [];
  let n = 0;
  for (const ev of events) if (ingestEvent(ev, divCode, divMeta) != null) n++;
  return n;
}

/** Derniers résultats d'une ligue (validation croisée des scores §6) */
export async function syncLeaguePast(divCode) {
  const divMeta = CONFIG.divisions[divCode];
  if (!divMeta?.tsdbLeagueId) return 0;
  const { data } = await fetchJson(`${BASE()}/eventspastleague.php?id=${divMeta.tsdbLeagueId}`,
    { sourceId: SOURCE_ID, ttlMs: 10 * 60_000 });
  const events = data?.events || [];
  let n = 0;
  for (const ev of events) if (ingestEvent(ev, divCode, divMeta) != null) n++;
  return n;
}

/** Détail d'une équipe (stade, pays) — enrichissement à la demande */
export async function lookupTeam(tsdbTeamId) {
  const { data } = await fetchJson(`${BASE()}/lookupteam.php?id=${tsdbTeamId}`,
    { sourceId: SOURCE_ID, ttlMs: 24 * 3600_000 });
  return data?.teams?.[0] || null;
}

/* ==================== SOURCE DISCOVERY ENGINE (autonome) ====================
 * Cycle : SEED → TEST (lookupleague, sport vérifié Soccer) → APPROVE/REJECT →
 * SYNC (eventsnextleague + eventspastleague). Respect strict du tier gratuit :
 * throttle 2 s entre appels, arrêt immédiat sur 429 (retry différé par le
 * scheduler). Une ligue testée est FUSIONNÉE avec une compétition CSV existante
 * quand son nom correspond au motif tsdbMatch — sinon créée sous code TSDB-<id>. */

const THROTTLE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ensemence la file de découverte avec les candidats configurés (idempotent). */
export function seedDiscovery() {
  const ins = db.prepare(`INSERT OR IGNORE INTO discovered_leagues
      (tsdb_id, status, discovered_via) VALUES (?, 'PENDING', 'seed')`);
  let n = 0;
  for (const id of CONFIG.tsdbSeedLeagueIds || []) {
    if (ins.run(id).changes) n++;
  }
  return n;
}

/** Rattache une ligue TSDB testée à une compétition existante (fusion) ou la crée. */
function classifyLeague(league) {
  const name = league.strLeague || '';
  for (const [code, meta] of Object.entries(CONFIG.extraLeagues || {})) {
    if (meta.tsdbMatch && meta.tsdbMatch.test(name)) {
      const comp = db.prepare(`SELECT id, code FROM competitions WHERE code=?`).get(code);
      if (comp) return { competitionId: comp.id, code, merged: true, meta: { name: meta.name, country: meta.country } };
    }
  }
  for (const [code, meta] of Object.entries(CONFIG.divisions || {})) {
    if (meta.tsdbLeagueId === league.idLeague) {
      const comp = db.prepare(`SELECT id, code FROM competitions WHERE code=?`).get(code);
      if (comp) return { competitionId: comp.id, code, merged: true, meta: { name: meta.name, country: meta.country } };
    }
  }
  const code = `TSDB-${league.idLeague}`;
  const meta = { name: league.strLeague, country: league.strCountry || null };
  const competitionId = upsertCompetition(code, meta.name, meta.country);
  return { competitionId, code, merged: false, meta };
}

/**
 * Teste un lot de candidats PENDING : lookupleague, vérification sport=Soccer,
 * puis APPROVED/REJECTED. Sur rate limit (429) : le candidat reste PENDING et
 * le lot s'arrête — jamais de contournement.
 */
export async function processDiscoveryBatch(batchSize = CONFIG.discoveryBatchSize) {
  const pending = db.prepare(`SELECT tsdb_id FROM discovered_leagues
      WHERE status='PENDING' ORDER BY tsdb_id ASC LIMIT ?`).all(batchSize);
  let tested = 0, approved = 0, rejected = 0;
  for (const cand of pending) {
    try {
      const { data } = await fetchJson(`${BASE()}/lookupleague.php?id=${cand.tsdb_id}`,
        { sourceId: SOURCE_ID, ttlMs: 24 * 3600_000 });
      const league = data?.leagues?.[0];
      tested++;
      if (!league || league.strSport !== 'Soccer') {
        db.prepare(`UPDATE discovered_leagues SET status='REJECTED', name=?, country=?, sport=?,
            reason=?, checked_at=? WHERE tsdb_id=?`)
          .run(league?.strLeague || null, league?.strCountry || null, league?.strSport || null,
            league ? `Sport non football : ${league.strSport}` : 'Ligue introuvable dans la source',
            now(), cand.tsdb_id);
        rejected++;
      } else {
        const cls = classifyLeague(league);
        db.prepare(`UPDATE discovered_leagues SET status='APPROVED', name=?, country=?, sport='Soccer',
            competition_code=?, reason=?, checked_at=? WHERE tsdb_id=?`)
          .run(league.strLeague, league.strCountry || null, cls.code,
            cls.merged ? `Fusionnée avec ${cls.code} (données CSV + TSDB)` : `Compétition créée (${cls.code})`,
            now(), cand.tsdb_id);
        approved++;
        notify('LEAGUES_DISCOVERED', { tsdbLeagueId: cand.tsdb_id, name: league.strLeague, code: cls.code });
      }
    } catch (e) {
      if (String(e.message).includes('429')) {
        db.prepare(`UPDATE discovered_leagues SET reason='Rate limit source — retest différé' WHERE tsdb_id=?`)
          .run(cand.tsdb_id);
        break; // respect du rate limit : on s'arrête, le scheduler retentera
      }
      db.prepare(`UPDATE discovered_leagues SET reason=? WHERE tsdb_id=?`)
        .run(`Erreur test : ${e.message}`, cand.tsdb_id);
    }
    await sleep(THROTTLE_MS);
  }
  return { tested, approved, rejected };
}

/** Synchronise les ligues découvertes APPROVED (calendrier + derniers résultats). */
export async function syncDiscoveredLeagues(batchSize = CONFIG.dynamicSyncBatchSize) {
  const leagues = db.prepare(`SELECT dl.tsdb_id, dl.name, dl.country, c.id AS competition_id, c.code
      FROM discovered_leagues dl JOIN competitions c ON c.code=dl.competition_code
      WHERE dl.status='APPROVED' ORDER BY dl.last_synced IS NOT NULL, dl.last_synced ASC LIMIT ?`).all(batchSize);
  let events = 0;
  const errors = [];
  for (const lg of leagues) {
    const divMeta = { name: lg.name, country: lg.country, code: lg.code };
    let leagueEvents = 0;
    try {
      for (const ep of ['eventsnextleague', 'eventspastleague']) {
        const { data } = await fetchJson(`${BASE()}/${ep}.php?id=${lg.tsdb_id}`,
          { sourceId: SOURCE_ID, ttlMs: 10 * 60_000 });
        for (const ev of data?.events || []) {
          if (ingestDynamicEvent(ev, lg.competition_id, divMeta) != null) leagueEvents++;
        }
        await sleep(THROTTLE_MS);
      }
      events += leagueEvents;
      db.prepare(`UPDATE discovered_leagues SET last_synced=?, events_found=? WHERE tsdb_id=?`)
        .run(now(), leagueEvents, lg.tsdb_id);
    } catch (e) {
      errors.push(`${lg.code}: ${e.message}`);
      if (String(e.message).includes('429')) break;
    }
  }
  return { leagues: leagues.length, events, errors };
}

/** Ingestion d'un événement TSDB dans une compétition déjà résolue (fusion). */
function ingestDynamicEvent(ev, competitionId, meta) {
  const homeId = upsertTeam(ev.strHomeTeam, meta.country, {
    badge_url: ev.strHomeTeamBadge || null,
    externalId: { source: SOURCE_ID, id: ev.idHomeTeam },
  });
  const awayId = upsertTeam(ev.strAwayTeam, meta.country, {
    badge_url: ev.strAwayTeamBadge || null,
    externalId: { source: SOURCE_ID, id: ev.idAwayTeam },
  });
  if (!homeId || !awayId) return null;
  const kickoff = ev.strTimestamp ? `${ev.strTimestamp}Z` : (ev.dateEvent ? `${ev.dateEvent}T${ev.strTime || '15:00:00'}Z` : null);
  if (!kickoff) return null;
  const venueId = ev.strVenue ? upsertVenue(ev.strVenue, ev.strCity || null, ev.strCountry || meta.country) : null;
  const hs = ev.intHomeScore !== '' && ev.intHomeScore != null ? parseInt(ev.intHomeScore, 10) : null;
  const as = ev.intAwayScore !== '' && ev.intAwayScore != null ? parseInt(ev.intAwayScore, 10) : null;
  const { id } = upsertFixture({
    competitionId, seasonCode: null,
    homeTeamId: homeId, awayTeamId: awayId,
    kickoffUtc: kickoff,
    status: mapStatus(ev),
    homeScore: hs, awayScore: as,
    venueId, round: ev.intRound ? `J${ev.intRound}` : null,
    sourceId: SOURCE_ID, externalId: ev.idEvent,
  });
  return id;
}

/** Cycle complet de découverte (appelé par le scheduler, jamais au boot bloquant). */
export async function discoverWorldLeagues() {
  const seeded = seedDiscovery();
  const batch = await processDiscoveryBatch();
  return { seeded, ...batch };
}

/** DEEP RESEARCH — ingestion d'un événement dont la ligue doit être DÉJÀ connue.
 *  Résout idLeague → compétition via la config ou les ligues découvertes ;
 *  retourne null si la ligue est inconnue (aucune compétition fantôme créée). */
export function ingestKnownLeagueEvent(ev) {
  const idLeague = ev?.idLeague;
  if (!idLeague || (ev.strSport && ev.strSport !== 'Soccer')) return null;
  for (const [code, meta] of Object.entries({ ...(CONFIG.divisions || {}), ...(CONFIG.extraLeagues || {}) })) {
    if (meta.tsdbLeagueId === idLeague) {
      const competitionId = upsertCompetition(code, meta.name, meta.country);
      return ingestDynamicEvent(ev, competitionId, { name: meta.name, country: meta.country });
    }
  }
  const dl = db.prepare(`SELECT c.id AS competition_id, dl.name, dl.country
      FROM discovered_leagues dl JOIN competitions c ON c.code=dl.competition_code
      WHERE dl.tsdb_id=? AND dl.status='APPROVED'`).get(idLeague);
  if (dl) return ingestDynamicEvent(ev, dl.competition_id, { name: dl.name, country: dl.country });
  return null;
}

/* ==================== LOGO ENGINE (équipes + compétitions) ====================
 * « Toutes les équipes des matchs du jour doivent avoir leur logo. »
 * Recherche ciblée, polie (2 s entre appels), uniquement pour ce qui manque :
 *   - équipes sans badge jouant dans les 72 h → searchteams.php (badge officiel)
 *   - compétitions sans logo avec id TSDB connu → lookupleague.php (strBadge)
 * Aucun logo inventé : si la source n'en publie pas, l'UI affiche l'initiale. */
export async function backfillTeamBadges(limit = 15) {
  const teams = db.prepare(`SELECT DISTINCT t.id, t.name, t.country FROM teams t
      JOIN fixtures f ON (f.home_team_id=t.id OR f.away_team_id=t.id)
      WHERE t.badge_url IS NULL
        AND f.kickoff_utc BETWEEN datetime('now', '-6 hours') AND datetime('now', '+72 hours')
      LIMIT ?`).all(limit);
  let found = 0;
  for (const t of teams) {
    try {
      const { data } = await fetchJson(`${BASE()}/searchteams.php?t=${encodeURIComponent(t.name)}`,
        { sourceId: SOURCE_ID, ttlMs: 7 * 24 * 3600_000 });
      const candidates = (data?.teams || []).filter((x) => x.strSport === 'Soccer');
      // correspondance stricte : même pays si connu, sinon nom exact — jamais un logo au hasard
      const match = candidates.find((x) => t.country && x.strCountry === t.country)
        || candidates.find((x) => (x.strTeam || '').toLowerCase() === t.name.toLowerCase());
      if (match?.strBadge) {
        db.prepare(`UPDATE teams SET badge_url=? WHERE id=?`).run(match.strBadge, t.id);
        found++;
      }
    } catch (e) {
      if (String(e.message).includes('429')) break; // respect strict du tier gratuit
    }
    await sleep(THROTTLE_MS);
  }
  return { checked: teams.length, found };
}

export async function backfillCompetitionLogos(limit = 8) {
  const comps = db.prepare(`SELECT id, code FROM competitions WHERE logo_url IS NULL LIMIT 50`).all();
  let found = 0, done = 0;
  for (const comp of comps) {
    if (done >= limit) break;
    // id TSDB : config (divisions/extraLeagues) ou ligue découverte
    let tsdbId = null;
    for (const meta of [CONFIG.divisions[comp.code], CONFIG.extraLeagues?.[comp.code]]) {
      if (meta?.tsdbLeagueId) tsdbId = meta.tsdbLeagueId;
    }
    if (!tsdbId && comp.code.startsWith('TSDB-')) tsdbId = comp.code.slice(5);
    if (!tsdbId) {
      const dl = db.prepare(`SELECT tsdb_id FROM discovered_leagues WHERE competition_code=?`).get(comp.code);
      tsdbId = dl?.tsdb_id || null;
    }
    if (!tsdbId) continue;
    done++;
    try {
      const { data } = await fetchJson(`${BASE()}/lookupleague.php?id=${tsdbId}`,
        { sourceId: SOURCE_ID, ttlMs: 7 * 24 * 3600_000 });
      const lg = data?.leagues?.[0];
      const logo = lg?.strBadge || lg?.strLogo || null;
      if (logo) {
        db.prepare(`UPDATE competitions SET logo_url=? WHERE id=?`).run(logo, comp.id);
        found++;
      }
    } catch (e) {
      if (String(e.message).includes('429')) break;
    }
    await sleep(THROTTLE_MS);
  }
  return { checked: done, found };
}
