// PRONO SPORT — Base de données (SQLite via better-sqlite3)
// Schéma complet conforme au cahier des charges §58.
// Chaque entité porte un PRONO_INTERNAL_ID (id) + IDs externes des sources (§59)
// et une provenance complète (§57).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true });
export const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS continents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
  continent_id INTEGER REFERENCES continents(id)
);
CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  country_id INTEGER REFERENCES countries(id),
  external_ids TEXT DEFAULT '{}',
  historical_from TEXT, historical_to TEXT
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER REFERENCES competitions(id),
  code TEXT NOT NULL, label TEXT,
  UNIQUE(competition_id, code)
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER REFERENCES seasons(id), name TEXT
);
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, city TEXT, country TEXT,
  lat REAL, lon REAL, external_ids TEXT DEFAULT '{}', UNIQUE(name, country)
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  country TEXT, badge_url TEXT, venue_id INTEGER REFERENCES venues(id),
  external_ids TEXT DEFAULT '{}',
  UNIQUE(normalized_name, country)
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id), position TEXT,
  external_ids TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
  team_id INTEGER REFERENCES teams(id), external_ids TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS referees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER REFERENCES competitions(id),
  season_code TEXT,
  home_team_id INTEGER REFERENCES teams(id),
  away_team_id INTEGER REFERENCES teams(id),
  kickoff_utc TEXT, status TEXT DEFAULT 'SCHEDULED',
  home_score INTEGER, away_score INTEGER,
  ht_home INTEGER, ht_away INTEGER,
  referee_id INTEGER REFERENCES referees(id),
  venue_id INTEGER REFERENCES venues(id),
  round TEXT,
  -- provenance (§57)
  source_ids TEXT DEFAULT '[]', external_ids TEXT DEFAULT '{}',
  data_tag TEXT DEFAULT 'SOURCE DATA',
  validation_status TEXT DEFAULT 'UNVERIFIED', -- VERIFIED | UNVERIFIED | DATA CONFLICT
  retrieved_at TEXT, updated_at TEXT,
  UNIQUE(competition_id, season_code, home_team_id, away_team_id, kickoff_utc)
);
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures(status);
CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff ON fixtures(kickoff_utc);
CREATE TABLE IF NOT EXISTS fixture_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  minute INTEGER, type TEXT, player_name TEXT, team_side TEXT,
  detail TEXT, source_id TEXT, retrieved_at TEXT,
  UNIQUE(fixture_id, minute, type, player_name, detail)
);
CREATE TABLE IF NOT EXISTS lineups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id), team_side TEXT,
  formation TEXT, players TEXT, source_id TEXT, retrieved_at TEXT
);
CREATE TABLE IF NOT EXISTS team_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id), team_side TEXT,
  shots INTEGER, shots_on_target INTEGER, fouls INTEGER,
  corners INTEGER, yellow INTEGER, red INTEGER,
  source_id TEXT, retrieved_at TEXT,
  UNIQUE(fixture_id, team_side)
);
CREATE TABLE IF NOT EXISTS player_statistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id),
  fixture_id INTEGER REFERENCES fixtures(id),
  minutes INTEGER, goals INTEGER, assists INTEGER, source_id TEXT
);
CREATE TABLE IF NOT EXISTS injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id), status TEXT,
  detail TEXT, source_id TEXT, retrieved_at TEXT
);
CREATE TABLE IF NOT EXISTS suspensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER REFERENCES players(id), detail TEXT,
  source_id TEXT, retrieved_at TEXT
);
CREATE TABLE IF NOT EXISTS weather (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER UNIQUE REFERENCES fixtures(id),
  temperature_c REAL, precipitation_mm REAL, wind_kmh REAL, humidity REAL,
  source_id TEXT, retrieved_at TEXT, data_tag TEXT DEFAULT 'SOURCE DATA'
);
CREATE TABLE IF NOT EXISTS data_sources (
  source_id TEXT PRIMARY KEY, source_name TEXT, source_url TEXT,
  source_type TEXT, data_categories TEXT, coverage TEXT,
  update_frequency TEXT, last_successful_fetch TEXT, last_failed_fetch TEXT,
  reliability_score REAL, availability_status TEXT DEFAULT 'UNTESTED',
  terms_status TEXT, attribution_required INTEGER DEFAULT 0,
  attribution_text TEXT, requires_key INTEGER DEFAULT 0,
  last_checked TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
  total_latency_ms INTEGER DEFAULT 0, notes TEXT
);
CREATE TABLE IF NOT EXISTS bookmakers (
  code TEXT PRIMARY KEY, name TEXT
);
CREATE TABLE IF NOT EXISTS markets (
  code TEXT PRIMARY KEY, name TEXT
);
CREATE TABLE IF NOT EXISTS odds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  bookmaker_code TEXT, market_code TEXT, selection TEXT,
  price REAL, source_id TEXT, retrieved_at TEXT, status TEXT DEFAULT 'ACTIVE',
  UNIQUE(fixture_id, bookmaker_code, market_code, selection)
);
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  bookmaker_code TEXT, market_code TEXT, selection TEXT,
  price REAL, source_id TEXT, snapshot_at TEXT
);
CREATE TABLE IF NOT EXISTS model_versions (
  version TEXT PRIMARY KEY, description TEXT,
  trained_at TEXT, training_matches INTEGER,
  backtest_brier REAL, backtest_logloss REAL, market_brier REAL,
  weights TEXT
);
CREATE TABLE IF NOT EXISTS model_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  model_name TEXT, model_version TEXT,
  p_home REAL, p_draw REAL, p_away REAL,
  lambda_home REAL, lambda_away REAL,
  computed_at TEXT, data_tag TEXT DEFAULT 'MODEL ESTIMATE',
  UNIQUE(fixture_id, model_name, model_version)
);
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  created_at TEXT, model_version TEXT, features_version TEXT,
  market TEXT, selection TEXT,
  probability REAL, market_probability REAL,
  odds REAL, fair_odds REAL, edge REAL, ev REAL,
  confidence REAL, data_quality REAL,
  decision TEXT,          -- PICK | VALUE BET | NO QUALIFIED PICK
  result TEXT DEFAULT 'PENDING', -- WIN | LOSS | VOID | PENDING
  settled_at TEXT, immutable INTEGER DEFAULT 1,
  data_tag TEXT DEFAULT 'MODEL ESTIMATE',
  rationale TEXT,
  UNIQUE(fixture_id, market, selection, model_version)
);
CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER REFERENCES predictions(id),
  snapshot_at TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS value_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id INTEGER UNIQUE REFERENCES predictions(id),
  fixture_id INTEGER REFERENCES fixtures(id),
  edge REAL, ev REAL, best_bookmaker TEXT, best_price REAL,
  avg_price REAL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS analysis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER UNIQUE REFERENCES fixtures(id),
  report TEXT, generated_at TEXT, data_quality REAL
);
CREATE TABLE IF NOT EXISTS data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT, entity_id INTEGER, score REAL,
  components TEXT, computed_at TEXT,
  UNIQUE(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT, started_at TEXT, finished_at TEXT,
  status TEXT, items INTEGER DEFAULT 0, errors TEXT, source_id TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT, payload TEXT, created_at TEXT, read INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'user',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT, entity_type TEXT, entity_id INTEGER, created_at TEXT,
  UNIQUE(user_key, entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS http_cache (
  url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT,
  content_hash TEXT, fetched_at TEXT
);
-- SOURCE DISCOVERY ENGINE (§4) : ligues candidates découvertes en ligne,
-- testées puis approuvées/rejetées de façon autonome. Rien n'est utilisé
-- sans être passé par TEST → VALIDATE.
CREATE TABLE IF NOT EXISTS discovered_leagues (
  tsdb_id TEXT PRIMARY KEY,
  name TEXT, country TEXT, sport TEXT,
  status TEXT DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED
  reason TEXT,
  competition_code TEXT,
  discovered_via TEXT,
  events_found INTEGER DEFAULT 0,
  checked_at TEXT, last_synced TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT
);
-- LIVE PREDICTION ENGINE (§53) : snapshots immuables des recalculs en direct
CREATE TABLE IF NOT EXISTS live_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER REFERENCES fixtures(id),
  minute INTEGER, score_home INTEGER, score_away INTEGER,
  p_home REAL, p_draw REAL, p_away REAL,
  exp_total_goals REAL, trigger TEXT, computed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_livepred_fixture ON live_predictions(fixture_id);
CREATE TABLE IF NOT EXISTS data_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT, entity_id INTEGER, field TEXT,
  values_json TEXT, detected_at TEXT, resolved INTEGER DEFAULT 0,
  resolution_rule TEXT
);
`);

export const now = () => new Date().toISOString();

export function logJob(jobName, sourceId, fn) {
  const started = now();
  const insert = db.prepare(
    `INSERT INTO sync_jobs (job_name, started_at, status, source_id) VALUES (?,?,?,?)`
  ).run(jobName, started, 'RUNNING', sourceId || null);
  const jobId = insert.lastInsertRowid;
  const finish = (status, items, errors) => {
    db.prepare(`UPDATE sync_jobs SET finished_at=?, status=?, items=?, errors=? WHERE id=?`)
      .run(now(), status, items || 0, errors ? String(errors).slice(0, 2000) : null, jobId);
  };
  return { jobId, finish };
}

export function notify(type, payload) {
  db.prepare(`INSERT INTO notifications (type, payload, created_at) VALUES (?,?,?)`)
    .run(type, JSON.stringify(payload), now());
}
