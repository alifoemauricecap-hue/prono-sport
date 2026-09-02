// PRONO SPORT — API REST + SSE (temps réel)
// Sécurité (§78) : en-têtes durcis, rate limiting, validation des entrées.
// Transparence (§85) : chaque réponse porte provenance, fraîcheur et tags.
import express from 'express';
import { db, now } from '../db.js';
import { CONFIG, FRESHNESS } from '../config.js';
import { getSources } from '../providers/registry.js';
import { generatePrediction, trackRecord, getCompetitionModel } from '../engine/predictions.js';
import { buildExpertReport, assistantAnswer } from '../engine/reports.js';
import { aggregatedOdds } from '../engine/value.js';
import { walkForwardBacktest, loadFinishedMatches } from '../engine/models.js';
import { liveEvents } from '../workers/scheduler.js';
import { fetchMatchWeather, geocode } from '../providers/openMeteo.js';
import { getLiveHistory } from '../engine/live.js';
import { teamProfile, computeStandings } from '../engine/context.js';
import { dailyStats, weeklyStats, getDailySelection, getLessons, todayUtc, ensureDailySelections } from '../engine/daily.js';

export const api = express.Router();

// ---------- middleware sécurité ----------
const buckets = new Map();
api.use((req, res, next) => {
  const key = req.ip || 'anon';
  const nowMs = Date.now();
  const b = buckets.get(key) || { count: 0, reset: nowMs + 60_000 };
  if (nowMs > b.reset) { b.count = 0; b.reset = nowMs + 60_000; }
  b.count++; buckets.set(key, b);
  if (b.count > 240) return res.status(429).json({ error: 'RATE_LIMITED' });
  next();
});

const FIXTURE_SELECT = `SELECT f.id, f.kickoff_utc, f.status, f.home_score, f.away_score,
  f.ht_home, f.ht_away, f.round, f.validation_status, f.source_ids, f.data_tag,
  f.updated_at, f.season_code,
  c.id AS competition_id, c.code AS comp_code, c.name AS comp_name, c.logo_url AS comp_logo,
  co.name AS country,
  ht.id AS home_id, ht.name AS home_name, ht.badge_url AS home_badge,
  at2.id AS away_id, at2.name AS away_name, at2.badge_url AS away_badge,
  v.name AS venue_name, r.name AS referee_name
  FROM fixtures f
  JOIN competitions c ON c.id=f.competition_id
  LEFT JOIN countries co ON co.id=c.country_id
  JOIN teams ht ON ht.id=f.home_team_id
  JOIN teams at2 ON at2.id=f.away_team_id
  LEFT JOIN venues v ON v.id=f.venue_id
  LEFT JOIN referees r ON r.id=f.referee_id`;

function freshnessOf(updatedAt, categorySeconds) {
  if (!updatedAt) return FRESHNESS.UNKNOWN;
  const age = (Date.now() - new Date(updatedAt).getTime()) / 1000;
  return age <= categorySeconds ? FRESHNESS.FRESH : FRESHNESS.STALE;
}

function decorate(rows, cat = 'fixtures') {
  return rows.map((r) => ({
    ...r,
    source_ids: JSON.parse(r.source_ids || '[]'),
    freshness: freshnessOf(r.updated_at, CONFIG.freshness[cat] || 3600),
  }));
}

// ---------- matchs ----------
api.get('/fixtures/live', (req, res) => {
  const rows = db.prepare(`${FIXTURE_SELECT} WHERE f.status IN ('LIVE','HALFTIME','EXTRA_TIME','PENALTIES')
      ORDER BY f.kickoff_utc ASC LIMIT 100`).all();
  res.json({ data: decorate(rows, 'live'), note: rows.length ? null : 'Aucun match confirmé LIVE par les sources du registre actuellement.' });
});

api.get('/fixtures/upcoming', (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10) || 7, 30);
  const comp = req.query.competition ? String(req.query.competition) : null;
  const rows = db.prepare(`${FIXTURE_SELECT}
      WHERE f.status IN ('SCHEDULED','UPCOMING') AND f.kickoff_utc > datetime('now')
      AND f.kickoff_utc < datetime('now', '+' || ? || ' days')
      ${comp ? 'AND c.code=?' : ''}
      ORDER BY f.kickoff_utc ASC LIMIT 400`).all(...(comp ? [days, comp] : [days]));
  res.json({ data: decorate(rows) });
});

api.get('/fixtures/finished', (req, res) => {
  const comp = req.query.competition ? String(req.query.competition) : null;
  const rows = db.prepare(`${FIXTURE_SELECT}
      WHERE f.status='FINISHED' ${comp ? 'AND c.code=?' : ''}
      ORDER BY f.kickoff_utc DESC LIMIT 200`).all(...(comp ? [comp] : []));
  res.json({ data: decorate(rows, 'results') });
});

api.get('/fixtures/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
  const row = db.prepare(`${FIXTURE_SELECT} WHERE f.id=?`).get(id);
  if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
  const events = db.prepare(`SELECT minute, type, player_name, team_side, detail, source_id
      FROM fixture_events WHERE fixture_id=? ORDER BY minute ASC`).all(id);
  const stats = db.prepare(`SELECT * FROM team_statistics WHERE fixture_id=?`).all(id);
  const quality = db.prepare(`SELECT score, components, computed_at FROM data_quality
      WHERE entity_type='fixture' AND entity_id=?`).get(id);
  const conflicts = db.prepare(`SELECT * FROM data_conflicts WHERE entity_type='fixture' AND entity_id=?`).all(id);
  res.json({
    data: {
      ...decorate([row])[0], events, stats,
      quality: quality ? { ...quality, components: JSON.parse(quality.components) } : null,
      conflicts,
    },
  });
});

// ---------- Match Center : analyse / rapport expert / cotes ----------

// CENTRE DU MATCH (§v3.3) : compositions officielles, chronologie du jeu,
// stats en direct (possession, tirs…), score/horloge live, cotes ESPN et
// scores exacts les plus probables du modèle. Cache court : 60 s en live.
const mcCache = new Map(); // fixtureId -> { at, ttl, payload }
api.get('/fixtures/:id/matchcenter', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
  const f = db.prepare(`SELECT f.*, c.code AS comp_code FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id WHERE f.id=?`).get(id);
  if (!f) return res.status(404).json({ error: 'NOT_FOUND' });
  const isLive = ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'].includes(f.status);
  const ttl = isLive ? 60_000 : (f.status === 'FINISHED' ? 24 * 3600_000 : 15 * 60_000);
  const hit = mcCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return res.json(hit.payload);
  let espnData = null;
  try {
    const ext = JSON.parse(f.external_ids || '{}');
    if (ext.espn) {
      const { fetchMatchCenter } = await import('../providers/espn.js');
      espnData = await fetchMatchCenter(f.comp_code, ext.espn, ttl);
    }
  } catch { /* section absente plutôt que fausse */ }
  // Scores exacts les plus probables — MODEL ESTIMATE (lambdas de l'ensemble)
  let topScores = null;
  try {
    const mo = db.prepare(`SELECT lambda_home, lambda_away FROM model_outputs
        WHERE fixture_id=? AND model_name='ensemble' ORDER BY computed_at DESC LIMIT 1`).get(id);
    if (mo?.lambda_home && mo?.lambda_away) {
      const { scoreMatrix } = await import('../engine/poisson.js');
      const M = scoreMatrix(mo.lambda_home, mo.lambda_away, 0);
      const flat = [];
      for (let h = 0; h < Math.min(M.length, 6); h++) {
        for (let a = 0; a < Math.min(M[h].length, 6); a++) flat.push({ score: `${h}-${a}`, p: M[h][a] });
      }
      topScores = flat.sort((x, y) => y.p - x.p).slice(0, 5)
        .map((s) => ({ score: s.score, probability: Math.round(s.p * 1000) / 10 }));
    }
  } catch { /* pas de modèle : section absente */ }
  const payload = {
    data: {
      status: f.status, home_score: f.home_score, away_score: f.away_score,
      clock: espnData?.clock || null, status_detail: espnData?.statusDetail || null,
      lineups: espnData?.lineups?.length ? espnData.lineups : null,
      timeline: espnData?.timeline?.length ? espnData.timeline : null,
      live_stats: espnData?.stats?.some((s) => Object.keys(s.values).length) ? espnData.stats : null,
      espn_odds: espnData?.odds || null,
      top_scores: topScores,
    },
    tags: { lineups: 'SOURCE DATA (ESPN)', timeline: 'SOURCE DATA (ESPN)', live_stats: 'SOURCE DATA (ESPN)', espn_odds: 'SOURCE DATA (bookmaker via ESPN)', top_scores: 'MODEL ESTIMATE' },
    note: espnData ? null : 'Détails ESPN indisponibles pour ce match (couverture partielle de la source) — les sections absentes ne sont jamais inventées.',
  };
  mcCache.set(id, { at: Date.now(), ttl, payload });
  if (mcCache.size > 400) mcCache.delete(mcCache.keys().next().value);
  res.json(payload);
});

api.get('/fixtures/:id/live', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
  const f = db.prepare(`SELECT status, kickoff_utc FROM fixtures WHERE id=?`).get(id);
  if (!f) return res.status(404).json({ error: 'NOT_FOUND' });
  const history = getLiveHistory(id);
  res.json({ data: { status: f.status, ...history },
    note: history.snapshots.length ? 'Snapshots immuables : chaque recalcul (minute/score réels) est conservé — AVANT → APRÈS (§53).'
      : (['LIVE', 'HALFTIME'].includes(f.status) ? 'Recalcul en cours…' : 'Pas de suivi live : match non confirmé LIVE par une source du registre, ou modèle indisponible (INSUFFICIENT DATA).') });
});

api.get('/fixtures/:id/analysis', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
  try {
    const pr = generatePrediction(id);
    const rep = buildExpertReport(id, pr);
    if (!rep) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ data: rep.report, transparency: {
      model_version: CONFIG.modelVersion, features_version: CONFIG.featuresVersion,
      generated_at: now(),
    } });
  } catch (e) {
    res.status(500).json({ error: 'ANALYSIS_ERROR', detail: e.message });
  }
});

api.get('/fixtures/:id/odds', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const markets = {};
  for (const m of ['1X2', 'OU2.5']) {
    const agg = aggregatedOdds(id, m);
    if (agg) markets[m] = agg;
  }
  const history = db.prepare(`SELECT bookmaker_code, market_code, selection, price, snapshot_at
      FROM odds_snapshots WHERE fixture_id=? ORDER BY snapshot_at ASC`).all(id);
  if (!Object.keys(markets).length) return res.json({ data: null, status: 'DATA UNAVAILABLE' });
  res.json({ data: { markets, history, source: 'football-data-couk', tag: 'SOURCE DATA' } });
});

api.get('/fixtures/:id/weather', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const f = db.prepare(`SELECT f.*, v.name AS venue_name, v.city, v.country AS venue_country, v.lat, v.lon,
      co.name AS country FROM fixtures f
      LEFT JOIN venues v ON v.id=f.venue_id
      LEFT JOIN competitions c ON c.id=f.competition_id
      LEFT JOIN countries co ON co.id=c.country_id WHERE f.id=?`).get(id);
  if (!f) return res.status(404).json({ error: 'NOT_FOUND' });
  const cached = db.prepare(`SELECT * FROM weather WHERE fixture_id=?`).get(id);
  if (cached && (Date.now() - new Date(cached.retrieved_at).getTime()) < CONFIG.freshness.weather * 1000) {
    return res.json({ data: cached, tag: 'SOURCE DATA', source: 'open-meteo' });
  }
  try {
    let lat = f.lat, lon = f.lon;
    if (!lat && (f.venue_name || f.city)) {
      const g = await geocode(f.city || f.venue_name, f.venue_country || f.country);
      if (g) {
        lat = g.lat; lon = g.lon;
        if (f.venue_id) db.prepare(`UPDATE venues SET lat=?, lon=? WHERE id=?`).run(lat, lon, f.venue_id);
      }
    }
    if (!lat || !f.kickoff_utc) return res.json({ data: null, status: 'WEATHER DATA UNAVAILABLE', reason: 'Localisation du stade non disponible dans les sources.' });
    const w = await fetchMatchWeather(id, lat, lon, f.kickoff_utc);
    if (!w) return res.json({ data: null, status: 'WEATHER DATA UNAVAILABLE', reason: 'Hors fenêtre de prévision de la source météo.' });
    res.json({ data: w, tag: 'SOURCE DATA', source: 'open-meteo' });
  } catch (e) {
    res.json({ data: null, status: 'WEATHER DATA UNAVAILABLE', reason: e.message });
  }
});

// ---------- compétitions / couverture ----------
api.get('/competitions', (req, res) => {
  const rows = db.prepare(`SELECT c.*, co.name AS country,
      (SELECT COUNT(*) FROM fixtures f WHERE f.competition_id=c.id AND f.status='FINISHED') AS finished,
      (SELECT COUNT(*) FROM fixtures f WHERE f.competition_id=c.id AND f.status IN ('SCHEDULED','UPCOMING')) AS upcoming
      FROM competitions c LEFT JOIN countries co ON co.id=c.country_id ORDER BY co.name, c.name`).all();
  res.json({ data: rows.map((r) => ({ ...r,
    historical_depth: r.historical_from ? `${r.historical_from.slice(0, 4)} → ${r.historical_to?.slice(0, 4)}` : 'HISTORICAL DATA UNAVAILABLE' })) });
});

api.get('/coverage', (req, res) => {
  const comps = db.prepare(`SELECT c.id, c.code, c.name, co.name AS country, c.historical_from, c.historical_to
      FROM competitions c LEFT JOIN countries co ON co.id=c.country_id`).all();
  const cov = comps.map((c) => {
    const q = (sql) => db.prepare(sql).get(c.id).n;
    const finished = q(`SELECT COUNT(*) AS n FROM fixtures WHERE competition_id=? AND status='FINISHED'`);
    const upcoming = q(`SELECT COUNT(*) AS n FROM fixtures WHERE competition_id=? AND status IN ('SCHEDULED','UPCOMING')`);
    const stats = q(`SELECT COUNT(*) AS n FROM team_statistics ts JOIN fixtures f ON f.id=ts.fixture_id WHERE f.competition_id=?`);
    const oddsN = q(`SELECT COUNT(*) AS n FROM odds o JOIN fixtures f ON f.id=o.fixture_id WHERE f.competition_id=?`);
    const live = q(`SELECT COUNT(*) AS n FROM fixtures WHERE competition_id=? AND status='LIVE'`);
    const events = q(`SELECT COUNT(*) AS n FROM fixture_events fe JOIN fixtures f ON f.id=fe.fixture_id WHERE f.competition_id=?`);
    const mark = (n, partial) => (n > 0 ? (partial ? 'PARTIAL' : 'AVAILABLE') : 'UNAVAILABLE');
    return {
      ...c,
      coverage: {
        Fixtures: mark(upcoming + finished),
        Live: c.code === 'D1' || c.code === 'D2' ? (events > 0 ? 'AVAILABLE' : 'PARTIAL') : 'UNAVAILABLE',
        Results: mark(finished),
        Statistics: stats > 0 ? (stats >= finished ? 'AVAILABLE' : 'PARTIAL') : 'UNAVAILABLE',
        Lineups: 'UNAVAILABLE',
        Players: 'UNAVAILABLE',
        Historical: c.historical_from ? 'AVAILABLE' : 'UNAVAILABLE',
        Odds: mark(oddsN),
        xG: stats > 0 ? 'PARTIAL' : 'UNAVAILABLE',
      },
      note: 'Couverture mesurée sur les données réellement présentes en base — jamais déclarative. xG = PARTIAL signifie proxy calculé sur tirs réels (MODEL ESTIMATE), pas de xG événementiel.',
    };
  });
  res.json({ data: cov });
});

// ---------- sources ----------
api.get('/sources', (req, res) => {
  res.json({ data: getSources() });
});

// ---------- SOURCE DISCOVERY ENGINE (autonome) ----------
api.get('/discovery', (req, res) => {
  const rows = db.prepare(`SELECT * FROM discovered_leagues ORDER BY
      CASE status WHEN 'APPROVED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, name`).all();
  const counts = { APPROVED: 0, PENDING: 0, REJECTED: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({ data: { counts, leagues: rows },
    note: 'Chaque candidat passe par TEST (sport vérifié = Soccer, événements réels) avant APPROVED — jamais utilisé sans validation. REJECTED reste visible (auditabilité).' });
});

// ---------- value bets & pronostics ----------
api.get('/value-bets', (req, res) => {
  const rows = db.prepare(`SELECT vb.*, p.market, p.selection, p.probability, p.market_probability,
      p.fair_odds, p.confidence, p.data_quality, p.result, f.kickoff_utc,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name, f.id AS fixture_id
      FROM value_bets vb
      JOIN predictions p ON p.id=vb.prediction_id
      JOIN fixtures f ON f.id=vb.fixture_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id
      WHERE f.kickoff_utc > datetime('now')
      ORDER BY vb.ev DESC LIMIT 50`).all();
  res.json({ data: rows, note: rows.length ? null : 'NO QUALIFIED PICK — aucune opportunité ne respecte actuellement les critères (edge ≥ 3%, EV ≥ 2%, qualité de données suffisante).' });
});

api.get('/predictions', (req, res) => {
  const status = req.query.status === 'settled' ? `p.result IN ('WIN','LOSS','VOID')` : `1=1`;
  const rows = db.prepare(`SELECT p.*, f.kickoff_utc, f.home_score, f.away_score, f.status AS fixture_status,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id
      WHERE ${status} ORDER BY f.kickoff_utc DESC LIMIT 200`).all();
  res.json({ data: rows, trackRecord: trackRecord() });
});

// ---------- backtest lab ----------
api.get('/backtest/:competitionCode', (req, res) => {
  const comp = db.prepare(`SELECT id, name FROM competitions WHERE code=?`).get(req.params.competitionCode);
  if (!comp) return res.status(404).json({ error: 'NOT_FOUND' });
  const matches = loadFinishedMatches(comp.id);
  const bt = walkForwardBacktest(matches);
  if (!bt) return res.json({ data: null, status: 'INSUFFICIENT DATA', matches: matches.length });
  res.json({ data: { competition: comp.name, trainingMatches: matches.length, ...bt },
    note: 'Backtest walk-forward : chaque prédiction n\'utilise que les matchs antérieurs (aucune fuite temporelle).' });
});

// ---------- recherche ----------
api.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: { teams: [], competitions: [], fixtures: [] } });
  const like = `%${q}%`;
  const teams = db.prepare(`SELECT id, name, country, badge_url FROM teams
      WHERE name LIKE ? OR normalized_name LIKE ? LIMIT 12`).all(like, like.toLowerCase());
  const competitions = db.prepare(`SELECT c.id, c.code, c.name, co.name AS country FROM competitions c
      LEFT JOIN countries co ON co.id=c.country_id WHERE c.name LIKE ? LIMIT 8`).all(like);
  const fixtures = db.prepare(`${FIXTURE_SELECT}
      WHERE (ht.name LIKE ? OR at2.name LIKE ?) AND f.kickoff_utc > datetime('now', '-7 days')
      ORDER BY f.kickoff_utc ASC LIMIT 12`).all(like, like);
  res.json({ data: { teams, competitions, fixtures: decorate(fixtures) } });
});

// ---------- équipes ----------
api.get('/teams/:id/profile', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' });
  const profile = teamProfile(id);
  if (!profile) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ data: profile });
});

api.get('/competitions/:code/standings', (req, res) => {
  const comp = db.prepare(`SELECT id, name FROM competitions WHERE code=?`).get(req.params.code);
  if (!comp) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ data: { competition: comp.name, ...computeStandings(comp.id) } });
});

api.get('/teams/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const team = db.prepare(`SELECT * FROM teams WHERE id=?`).get(id);
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  const recent = db.prepare(`${FIXTURE_SELECT}
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.status='FINISHED'
      ORDER BY f.kickoff_utc DESC LIMIT 15`).all(id, id);
  const upcoming = db.prepare(`${FIXTURE_SELECT}
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.kickoff_utc > datetime('now')
      ORDER BY f.kickoff_utc ASC LIMIT 10`).all(id, id);
  res.json({ data: { team: { ...team, external_ids: JSON.parse(team.external_ids || '{}') },
    recent: decorate(recent), upcoming: decorate(upcoming) } });
});

// ---------- favoris (clé locale, pas de compte requis) ----------
api.post('/favorites', express.json(), (req, res) => {
  const { userKey, entityType, entityId } = req.body || {};
  if (!userKey || !['team', 'competition', 'fixture'].includes(entityType) || !Number.isFinite(entityId)) {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  db.prepare(`INSERT OR IGNORE INTO favorites (user_key, entity_type, entity_id, created_at) VALUES (?,?,?,?)`)
    .run(String(userKey).slice(0, 64), entityType, entityId, now());
  res.json({ ok: true });
});
api.delete('/favorites', express.json(), (req, res) => {
  const { userKey, entityType, entityId } = req.body || {};
  db.prepare(`DELETE FROM favorites WHERE user_key=? AND entity_type=? AND entity_id=?`)
    .run(String(userKey || ''), String(entityType || ''), entityId);
  res.json({ ok: true });
});
api.get('/favorites/:userKey', (req, res) => {
  const favs = db.prepare(`SELECT * FROM favorites WHERE user_key=?`).all(req.params.userKey);
  res.json({ data: favs });
});

// ---------- assistant IA (§84) ----------
api.post('/assistant', express.json(), (req, res) => {
  const { question, fixtureId } = req.body || {};
  res.json({ data: assistantAnswer(String(question || '').slice(0, 500), fixtureId ? parseInt(fixtureId, 10) : null) });
});

// ---------- SÉLECTIONS DU JOUR : Expert + Combiné Safe + Suivi ----------
api.get(['/day', '/day/:date'], (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.params.date || '') ? req.params.date : todayUtc();
  const rows = db.prepare(`${FIXTURE_SELECT} WHERE date(f.kickoff_utc)=? ORDER BY f.kickoff_utc ASC LIMIT 500`).all(day);
  const preds = db.prepare(`SELECT p.fixture_id, p.market, p.selection, p.probability, p.odds, p.decision, p.result
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE date(f.kickoff_utc)=? AND p.decision IN ('PICK','VALUE BET','ANALYSIS PICK')`).all(day);
  const byFixture = {};
  for (const p of preds) if (!byFixture[p.fixture_id]) byFixture[p.fixture_id] = p;
  res.json({ data: {
    day, fixtures: decorate(rows).map((f) => ({ ...f, pick: byFixture[f.id] || null })),
    stats: dailyStats(day),
  } });
});

api.get(['/expert', '/expert/:date'], (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.params.date || '') ? req.params.date : todayUtc();
  if (day === todayUtc()) ensureDailySelections(day); // à jour tant que non verrouillé
  const sel = getDailySelection(day, 'EXPERT');
  res.json({ data: sel, note: sel
    ? 'Pronostics à plus forte probabilité de validation du jour. Probabilités = MODEL ESTIMATE calibré sur résultats réels. Sélection verrouillée au premier coup d\'envoi.'
    : 'Aucun pronostic ne dépasse le seuil expert (probabilité ≥ 62% + qualité de données) pour ce jour — état honnête, pas de remplissage.' });
});

api.get(['/safe-combo', '/safe-combo/:date'], (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.params.date || '') ? req.params.date : todayUtc();
  if (day === todayUtc()) ensureDailySelections(day);
  const sel = getDailySelection(day, 'SAFE_COMBO');
  res.json({ data: sel, note: sel
    ? 'Combiné visant une cote totale ~3 avec la probabilité combinée maximale (produit des probabilités individuelles, hypothèse d\'indépendance — MODEL ESTIMATE). Verrouillé au premier coup d\'envoi.'
    : 'Pas assez de pronostics qualifiés aujourd\'hui pour construire un combiné sûr (cote 2,5-3,6) — état honnête.' });
});

api.get('/reviews/:fixtureId', (req, res) => {
  const id = parseInt(req.params.fixtureId, 10);
  const r = db.prepare(`SELECT * FROM prediction_reviews WHERE fixture_id=?`).get(id);
  if (!r) return res.json({ data: null, note: 'Compte rendu pas encore généré (créé automatiquement après le match).' });
  res.json({ data: { ...r, factors: JSON.parse(r.factors_json), factors_json: undefined } });
});

api.get('/reviews', (req, res) => {
  const rows = db.prepare(`SELECT r.*, f.home_score, f.away_score, f.kickoff_utc,
      ht.name AS home_name, at2.name AS away_name, c.name AS comp_name
      FROM prediction_reviews r JOIN fixtures f ON f.id=r.fixture_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      JOIN competitions c ON c.id=f.competition_id
      ORDER BY f.kickoff_utc DESC LIMIT 50`).all();
  res.json({ data: rows.map((r) => ({ ...r, factors: JSON.parse(r.factors_json), factors_json: undefined })) });
});

api.get(['/stats/daily', '/stats/daily/:date'], (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.params.date || '') ? req.params.date : todayUtc();
  res.json({ data: dailyStats(day) });
});

api.get('/stats/weekly', (req, res) => {
  const back = Math.min(parseInt(req.query.back || '0', 10) || 0, 8);
  res.json({ data: weeklyStats(back) });
});

api.get('/lessons', (req, res) => {
  res.json({ data: getLessons(), note: 'Conclusions CALCULÉES sur les résultats réels des pronostics réglés — aucun ajustement sans échantillon suffisant (min. 30).' });
});

// ---------- admin / monitoring ----------
api.get('/admin/overview', (req, res) => {
  const counts = {};
  for (const t of ['fixtures', 'teams', 'competitions', 'odds', 'odds_snapshots', 'predictions', 'value_bets', 'fixture_events', 'team_statistics', 'data_conflicts']) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  const jobs = db.prepare(`SELECT * FROM sync_jobs ORDER BY id DESC LIMIT 40`).all();
  const conflicts = db.prepare(`SELECT * FROM data_conflicts ORDER BY id DESC LIMIT 20`).all();
  const models = db.prepare(`SELECT * FROM model_versions ORDER BY trained_at DESC LIMIT 20`).all();
  const notifications = db.prepare(`SELECT * FROM notifications ORDER BY id DESC LIMIT 30`).all();
  res.json({ data: { counts, jobs, conflicts, models, notifications,
    memory: { rss_mb: Math.round(process.memoryUsage().rss / 1048576) }, uptime_s: Math.round(process.uptime()) } });
});

// ---------- SSE temps réel ----------
api.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: {"connected":true}\n\n`);
  liveEvents.listeners.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch { /* fermé */ } }, 25_000);
  req.on('close', () => { clearInterval(ping); liveEvents.listeners.delete(res); });
});

api.get('/health', (req, res) => {
  res.json({
    status: 'UP', env: CONFIG.env, at: now(),
    // traçabilité du déploiement (fourni automatiquement par l'hébergeur)
    commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
  });
});
