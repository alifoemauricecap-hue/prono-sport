// PRONO SPORT — Fournisseur ESPN (API JSON publique, sans clé) — SOURCE DATA.
// Rôle : COMBLER LES TROUS DE COUVERTURE. Quand une compétition n'a pas assez
// d'historique via les autres sources (ex. Saudi Pro League), le moteur de
// recherche ciblée (workers/research.js) interroge ESPN pour reconstituer
// l'historique réel de la compétition — résultats officiels, jamais inventés.
// Chaque ligue ci-dessous a été TESTÉE réellement (scoreboard non vide) avant
// d'être inscrite. Requêtes espacées (politesse §5), échecs journalisés.
import { fetchJson } from '../util/http.js';
import { db, now } from '../db.js';
import { upsertCompetition, upsertTeam, upsertFixture } from './repository.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SOURCE_ID = 'espn';
const GAP_MS = 1500; // espacement minimal entre requêtes vers ESPN
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeJson(url) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const { data } = await fetchJson(url, { sourceId: SOURCE_ID, ttlMs: 90_000 });
  return data;
}

// Ligues ESPN vérifiées (slug testé, scoreboard non vide). `match` est testé
// contre "<nom compétition> <pays>" pour rattacher une compétition existante
// (créée par la découverte TheSportsDB ou les CSV) — PAS de doublon de compétition.
export const ESPN_LEAGUES = [
  { slug: 'ksa.1', name: 'Saudi Pro League', country: 'Saudi Arabia', match: /saudi/i },
  { slug: 'arg.1', name: 'Liga Profesional (Argentine)', country: 'Argentina', match: /argentin/i },
  { slug: 'bra.1', name: 'Série A (Brésil)', country: 'Brazil', match: /brazil|brasil|brésil/i },
  { slug: 'chn.1', name: 'Super League (Chine)', country: 'China', match: /chin[ae]|chinese/i },
  { slug: 'jpn.1', name: 'J1 League (Japon)', country: 'Japan', match: /japan|japon|j1 league/i },
  { slug: 'mex.1', name: 'Liga MX (Mexique)', country: 'Mexico', match: /mexi|liga mx/i },
  { slug: 'usa.1', name: 'MLS (États-Unis)', country: 'United States', match: /major league soccer|\bmls\b|united states/i },
  { slug: 'aus.1', name: 'A-League (Australie)', country: 'Australia', match: /australi|a-league/i },
  { slug: 'nor.1', name: 'Eliteserien (Norvège)', country: 'Norway', match: /norw|norvège|eliteserien/i },
  { slug: 'swe.1', name: 'Allsvenskan (Suède)', country: 'Sweden', match: /swed|suède|allsvenskan/i },
  { slug: 'den.1', name: 'Superliga (Danemark)', country: 'Denmark', match: /denmark|danish|danemark/i },
  { slug: 'rsa.1', name: 'Premiership (Afrique du Sud)', country: 'South Africa', match: /south africa|afrique du sud/i },
  { slug: 'idn.1', name: 'Super League (Indonésie)', country: 'Indonesia', match: /indonesi/i },
];

/** Trouve la ligue ESPN correspondant à une compétition existante (nom + pays). */
export function findEspnLeagueForCompetition(compName, compCountry) {
  const haystack = `${compName || ''} ${compCountry || ''}`;
  return ESPN_LEAGUES.find((l) => l.match.test(haystack)) || null;
}

function mapStatus(ev) {
  const t = ev?.status?.type || {};
  if (t.state === 'post' && t.completed) return 'FINISHED';
  if (t.state === 'in') return 'LIVE';
  if (t.state === 'post') return 'FINISHED';
  return 'SCHEDULED';
}

function fmtDates(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Ingestion d'un événement ESPN dans une compétition EXISTANTE (jamais de doublon de comp). */
function ingestEvent(ev, competitionId, country, seasonYear) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home?.team?.displayName || !away?.team?.displayName) return null;
  const homeId = upsertTeam(home.team.displayName, country, {
    badge_url: home.team.logo || null,
    externalId: { source: SOURCE_ID, id: home.team.id },
  });
  const awayId = upsertTeam(away.team.displayName, country, {
    badge_url: away.team.logo || null,
    externalId: { source: SOURCE_ID, id: away.team.id },
  });
  if (!homeId || !awayId) return null;
  const status = mapStatus(ev);
  const hs = home.score != null && home.score !== '' ? parseInt(home.score, 10) : null;
  const as = away.score != null && away.score !== '' ? parseInt(away.score, 10) : null;
  return upsertFixture({
    competitionId,
    seasonCode: seasonYear ? String(seasonYear) : null,
    homeTeamId: homeId,
    awayTeamId: awayId,
    kickoffUtc: new Date(ev.date).toISOString(),
    status,
    homeScore: status === 'SCHEDULED' ? null : hs,
    awayScore: status === 'SCHEDULED' ? null : as,
    sourceId: SOURCE_ID,
    externalId: ev.id,
    dataTag: 'SOURCE DATA',
  });
}

/**
 * RECHERCHE APPROFONDIE : reconstitue l'historique réel d'une ligue via ESPN,
 * par fenêtres de 45 jours, en remontant `daysBack` jours. Idempotent.
 */
export async function syncEspnHistory(slug, competitionId, country, daysBack = 760) {
  let ingested = 0, finished = 0;
  const errors = [];
  const DAY = 86_400_000;
  for (let start = daysBack; start > -10; start -= 45) {
    const from = new Date(Date.now() - start * DAY);
    const to = new Date(Math.min(Date.now() + 10 * DAY, from.getTime() + 45 * DAY));
    try {
      const data = await politeJson(`${BASE}/${slug}/scoreboard?dates=${fmtDates(from)}-${fmtDates(to)}`);
      const seasonYear = data?.leagues?.[0]?.season?.year || null;
      for (const ev of data?.events || []) {
        const r = ingestEvent(ev, competitionId, country, seasonYear);
        if (r) { ingested++; if (mapStatus(ev) === 'FINISHED') finished++; }
      }
    } catch (e) {
      errors.push(`${slug} ${fmtDates(from)}: ${e.message}`);
      if (errors.length >= 4) break; // source indisponible : on n'insiste pas (§5)
    }
  }
  return { total: ingested, finished, errors };
}

/**
 * Rafraîchissement court (récents + à venir + LIVE) : fenêtre -3 j → +10 j.
 * Utilisé pour le suivi live des ligues couvertes par ESPN.
 */
export async function syncEspnRecent(slug, competitionId, country) {
  const DAY = 86_400_000;
  const from = new Date(Date.now() - 3 * DAY);
  const to = new Date(Date.now() + 10 * DAY);
  const data = await politeJson(`${BASE}/${slug}/scoreboard?dates=${fmtDates(from)}-${fmtDates(to)}`);
  const seasonYear = data?.leagues?.[0]?.season?.year || null;
  let total = 0, liveCount = 0;
  for (const ev of data?.events || []) {
    const r = ingestEvent(ev, competitionId, country, seasonYear);
    if (r) { total++; if (mapStatus(ev) === 'LIVE') liveCount++; }
  }
  return { total, liveCount, errors: [] };
}

/**
 * Compétitions existantes rattachables à une ligue ESPN (pour le live et le
 * rafraîchissement) : renvoie [{ competitionId, slug, country }] sans doublons.
 */
export function mappedCompetitions() {
  const rows = db.prepare(`SELECT c.id, c.name, co.name AS country
      FROM competitions c LEFT JOIN countries co ON co.id = c.country_id`).all();
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const lg = findEspnLeagueForCompetition(row.name, row.country);
    if (lg && !seen.has(lg.slug)) {
      seen.add(lg.slug);
      out.push({ competitionId: row.id, slug: lg.slug, country: lg.country, name: row.name });
    }
  }
  return out;
}
