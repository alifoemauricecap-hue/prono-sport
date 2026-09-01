// PRONO SPORT — Adapter Football-Data.co.uk
// Implémente : HistoricalDataProvider + OddsProvider + FootballDataProvider (fixtures)
// SOURCE DATA réelle : résultats, statistiques (tirs, corners, cartons, arbitre)
// et cotes réelles publiées (Bet365, Betfair, Pinnacle, moyennes et maxima du marché).
import { fetchText } from '../util/http.js';
import { parseCsv } from '../util/csv.js';
import { CONFIG } from '../config.js';
import { db, now } from '../db.js';
import {
  upsertCompetition, upsertTeam, upsertReferee, upsertFixture, saveTeamStats, saveOdds,
} from './repository.js';

const SOURCE_ID = 'football-data-couk';
const BASE = 'https://www.football-data.co.uk';

// Les cotes présentes dans les CSV sont de vraies cotes publiées par la source.
const BOOK_1X2 = [
  ['B365', 'Bet365'], ['BW', 'Betway'], ['PS', 'Pinnacle'], ['P', 'Pinnacle'],
  ['WH', 'William Hill'], ['BF', 'Betfair'], ['BFD', 'Betfair'], ['BFE', 'Betfair Exchange'],
  ['1XB', '1xBet'], ['BV', 'BetVictor'], ['PP', 'Paddy Power'], ['SKB', 'Skybet'],
  ['Max', 'Marché (max)'], ['Avg', 'Marché (moyenne)'],
];

function parseUkDate(d, t) {
  // Format source : DD/MM/YYYY (ou DD/MM/YY) + HH:MM
  if (!d) return null;
  const [dd, mm, yy] = d.split('/');
  if (!dd || !mm || !yy) return null;
  const year = yy.length === 2 ? (parseInt(yy, 10) > 80 ? `19${yy}` : `20${yy}`) : yy;
  const time = t && /^\d{2}:\d{2}/.test(t) ? t : '15:00';
  // Heures listées en heure locale UK par la source
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${time}:00Z`;
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

function ingestRow(row, { isFixture }) {
  const divCode = row.Div;
  const divMeta = CONFIG.divisions[divCode];
  if (!divMeta) return null; // division hors périmètre configuré
  const competitionId = upsertCompetition(divCode, divMeta.name, divMeta.country);
  const homeId = upsertTeam(row.HomeTeam, divMeta.country);
  const awayId = upsertTeam(row.AwayTeam, divMeta.country);
  if (!homeId || !awayId) return null;
  const kickoff = parseUkDate(row.Date, row.Time);
  if (!kickoff) return null;
  const refereeId = upsertReferee(row.Referee);

  const finished = !isFixture && row.FTHG !== '' && row.FTHG != null;
  const seasonCode = seasonFromDate(kickoff);
  const { id: fixtureId } = upsertFixture({
    competitionId, seasonCode,
    homeTeamId: homeId, awayTeamId: awayId,
    kickoffUtc: kickoff,
    status: finished ? 'FINISHED' : (new Date(kickoff) > new Date() ? 'SCHEDULED' : 'UNKNOWN'),
    homeScore: finished ? int(row.FTHG) : null,
    awayScore: finished ? int(row.FTAG) : null,
    htHome: finished ? int(row.HTHG) : null,
    htAway: finished ? int(row.HTAG) : null,
    refereeId,
    sourceId: SOURCE_ID,
  });

  if (finished) {
    if (row.HS !== '' && row.HS != null) {
      saveTeamStats(fixtureId, 'home', {
        shots: int(row.HS), shotsOnTarget: int(row.HST), fouls: int(row.HF),
        corners: int(row.HC), yellow: int(row.HY), red: int(row.HR),
      }, SOURCE_ID);
      saveTeamStats(fixtureId, 'away', {
        shots: int(row.AS), shotsOnTarget: int(row.AST), fouls: int(row.AF),
        corners: int(row.AC), yellow: int(row.AY), red: int(row.AR),
      }, SOURCE_ID);
    }
  }

  // Cotes 1X2 réelles
  for (const [code, name] of BOOK_1X2) {
    const h = num(row[`${code}H`]), d = num(row[`${code}D`]), a = num(row[`${code}A`]);
    if (h && d && a) {
      db.prepare(`INSERT OR IGNORE INTO bookmakers (code, name) VALUES (?,?)`).run(code, name);
      saveOdds(fixtureId, code, '1X2', 'HOME', h, SOURCE_ID);
      saveOdds(fixtureId, code, '1X2', 'DRAW', d, SOURCE_ID);
      saveOdds(fixtureId, code, '1X2', 'AWAY', a, SOURCE_ID);
    }
  }
  // Over/Under 2.5 réels
  for (const code of ['B365', 'P', 'Max', 'Avg', 'BFE']) {
    const over = num(row[`${code}>2.5`]), under = num(row[`${code}<2.5`]);
    if (over && under) {
      saveOdds(fixtureId, code, 'OU2.5', 'OVER', over, SOURCE_ID);
      saveOdds(fixtureId, code, 'OU2.5', 'UNDER', under, SOURCE_ID);
    }
  }
  return fixtureId;
}

export function seasonFromDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 6 ? y : y - 1; // saison européenne juil→juin
  return `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`;
}

/** Historique : CSV de saison par division (HistoricalDataProvider) */
export async function syncHistoricalSeason(seasonCode, divCode) {
  const url = `${BASE}/mmz4281/${seasonCode}/${divCode}.csv`;
  const { body } = await fetchText(url, { sourceId: SOURCE_ID, ttlMs: CONFIG.freshness.historical * 1000 });
  const rows = parseCsv(body);
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) if (ingestRow(row, { isFixture: false }) != null) count++;
  });
  tx();
  // profondeur historique réelle (§18)
  const comp = db.prepare(`SELECT id FROM competitions WHERE code=?`).get(divCode);
  if (comp) {
    const range = db.prepare(`SELECT MIN(kickoff_utc) AS mn, MAX(kickoff_utc) AS mx FROM fixtures WHERE competition_id=? AND status='FINISHED'`).get(comp.id);
    db.prepare(`UPDATE competitions SET historical_from=?, historical_to=? WHERE id=?`)
      .run(range.mn?.slice(0, 10) || null, range.mx?.slice(0, 10) || null, comp.id);
  }
  return count;
}

/** Fixtures à venir + cotes réelles (fixtures.csv, mis à jour par la source) */
export async function syncUpcomingFixtures() {
  const url = `${BASE}/fixtures.csv`;
  const { body } = await fetchText(url, { sourceId: SOURCE_ID, ttlMs: 10 * 60_000 });
  const rows = parseCsv(body);
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) if (ingestRow(row, { isFixture: true }) != null) count++;
  });
  tx();
  return count;
}

/** Résultats récents : le CSV de la saison courante inclut les derniers matchs joués */
export async function syncRecentResults() {
  const currentSeason = seasonFromDate(new Date().toISOString());
  let total = 0;
  const errors = [];
  for (const divCode of Object.keys(CONFIG.divisions)) {
    try { total += await syncHistoricalSeason(currentSeason, divCode); }
    catch (e) { errors.push(`${divCode}: ${e.message}`); }
  }
  return { total, errors };
}

/* ==================== LIGUES MONDIALES (/new/) ====================
 * Format réel vérifié : Country,League,Season,Date,Time,Home,Away,HG,AG,Res,
 * PSC/MaxC/AvgC/BFEC/B365C (cotes de clôture réelles). Saison = année civile
 * ou AAAA/AAAA. Fixtures mondiales cotées : new_league_fixtures.csv
 * (PS/Max/Avg/BFE/B365 pré-match). */

const WORLD_BOOKS_CLOSING = [
  ['PSC', 'Pinnacle (clôture)'], ['MaxC', 'Marché (max, clôture)'],
  ['AvgC', 'Marché (moyenne, clôture)'], ['BFEC', 'Betfair Exchange (clôture)'],
  ['B365C', 'Bet365 (clôture)'],
];
const WORLD_BOOKS_PRE = [
  ['PS', 'Pinnacle'], ['Max', 'Marché (max)'], ['Avg', 'Marché (moyenne)'],
  ['BFE', 'Betfair Exchange'], ['B365', 'Bet365'],
];

// pays → code compétition (1 ligue extraLeagues par pays ; alias USA)
const COUNTRY_TO_CODE = (() => {
  const m = new Map();
  for (const [code, meta] of Object.entries(CONFIG.extraLeagues || {})) {
    m.set(meta.country.toLowerCase(), code);
  }
  m.set('usa', 'USA1');
  return m;
})();

function worldSeasonCode(s) {
  if (!s) return null;
  return String(s).includes('/') ? String(s).split('/').map((x) => x.slice(2)).join('') : String(s);
}

function ingestWorldRow(row, code, meta, { isFixture }) {
  const competitionId = upsertCompetition(code, meta.name, meta.country);
  const homeId = upsertTeam(row.Home, meta.country);
  const awayId = upsertTeam(row.Away, meta.country);
  if (!homeId || !awayId) return null;
  const kickoff = parseUkDate(row.Date, row.Time);
  if (!kickoff) return null;
  const finished = !isFixture && row.HG !== '' && row.HG != null;
  const { id: fixtureId } = upsertFixture({
    competitionId,
    seasonCode: worldSeasonCode(row.Season),
    homeTeamId: homeId, awayTeamId: awayId,
    kickoffUtc: kickoff,
    status: finished ? 'FINISHED' : (new Date(kickoff) > new Date() ? 'SCHEDULED' : 'UNKNOWN'),
    homeScore: finished ? int(row.HG) : null,
    awayScore: finished ? int(row.AG) : null,
    htHome: null, htAway: null, refereeId: null,
    sourceId: SOURCE_ID,
  });
  const books = isFixture ? WORLD_BOOKS_PRE : WORLD_BOOKS_CLOSING;
  for (const [bcode, bname] of books) {
    const h = num(row[`${bcode}H`]), d = num(row[`${bcode}D`]), a = num(row[`${bcode}A`]);
    if (h && d && a) {
      db.prepare(`INSERT OR IGNORE INTO bookmakers (code, name) VALUES (?,?)`).run(bcode, bname);
      saveOdds(fixtureId, bcode, '1X2', 'HOME', h, SOURCE_ID);
      saveOdds(fixtureId, bcode, '1X2', 'DRAW', d, SOURCE_ID);
      saveOdds(fixtureId, bcode, '1X2', 'AWAY', a, SOURCE_ID);
    }
  }
  return fixtureId;
}

/** Historique complet d'une ligue mondiale (/new/<FILE>.csv, depuis ~2012) */
export async function syncExtraLeague(code) {
  const meta = CONFIG.extraLeagues[code];
  if (!meta) return 0;
  const url = `${BASE}/new/${meta.file}.csv`;
  const { body } = await fetchText(url, { sourceId: SOURCE_ID, ttlMs: CONFIG.freshness.historical * 1000 });
  const rows = parseCsv(body);
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) if (ingestWorldRow(row, code, meta, { isFixture: false }) != null) count++;
  });
  tx();
  const comp = db.prepare(`SELECT id FROM competitions WHERE code=?`).get(code);
  if (comp) {
    const range = db.prepare(`SELECT MIN(kickoff_utc) AS mn, MAX(kickoff_utc) AS mx FROM fixtures WHERE competition_id=? AND status='FINISHED'`).get(comp.id);
    db.prepare(`UPDATE competitions SET historical_from=?, historical_to=? WHERE id=?`)
      .run(range.mn?.slice(0, 10) || null, range.mx?.slice(0, 10) || null, comp.id);
  }
  return count;
}

/** Toutes les ligues mondiales configurées */
export async function syncExtraLeagues() {
  let total = 0;
  const errors = [];
  for (const code of Object.keys(CONFIG.extraLeagues || {})) {
    try { total += await syncExtraLeague(code); }
    catch (e) { errors.push(`${code}: ${e.message}`); }
  }
  return { total, errors };
}

/** Fixtures mondiales à venir AVEC cotes réelles (new_league_fixtures.csv) */
export async function syncWorldFixtures() {
  const url = `${BASE}/new_league_fixtures.csv`;
  const { body } = await fetchText(url, { sourceId: SOURCE_ID, ttlMs: 10 * 60_000 });
  const rows = parseCsv(body);
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const code = COUNTRY_TO_CODE.get((row.Country || '').toLowerCase());
      const meta = code ? CONFIG.extraLeagues[code] : null;
      if (!meta) continue; // pays hors périmètre : ignoré, jamais deviné
      if (ingestWorldRow(row, code, meta, { isFixture: true }) != null) count++;
    }
  });
  tx();
  return count;
}
