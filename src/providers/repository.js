// PRONO SPORT — Repository : upsert d'entités avec provenance (§57),
// fusion multi-sources (§7) et détection de conflits (§6).
import { db, now } from '../db.js';
import { normalizeTeamName } from '../util/teamNames.js';

export function upsertCountry(name) {
  if (!name) return null;
  db.prepare(`INSERT OR IGNORE INTO countries (name) VALUES (?)`).run(name);
  return db.prepare(`SELECT id FROM countries WHERE name=?`).get(name).id;
}

export function upsertCompetition(code, name, country) {
  const countryId = upsertCountry(country);
  db.prepare(`INSERT INTO competitions (code, name, country_id) VALUES (?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name`).run(code, name, countryId);
  return db.prepare(`SELECT id FROM competitions WHERE code=?`).get(code).id;
}

export function upsertTeam(rawName, country, extra = {}) {
  const normalized = normalizeTeamName(rawName);
  if (!normalized) return null;
  const existing = db.prepare(`SELECT * FROM teams WHERE normalized_name=? AND (country=? OR country IS NULL OR ?='')`)
    .get(normalized, country || '', country || '');
  if (existing) {
    if (extra.badge_url && !existing.badge_url) {
      db.prepare(`UPDATE teams SET badge_url=? WHERE id=?`).run(extra.badge_url, existing.id);
    }
    if (extra.externalId) {
      const ext = JSON.parse(existing.external_ids || '{}');
      if (!ext[extra.externalId.source]) {
        ext[extra.externalId.source] = extra.externalId.id;
        db.prepare(`UPDATE teams SET external_ids=? WHERE id=?`).run(JSON.stringify(ext), existing.id);
      }
    }
    return existing.id;
  }
  const ext = extra.externalId ? { [extra.externalId.source]: extra.externalId.id } : {};
  const r = db.prepare(`INSERT INTO teams (name, normalized_name, country, badge_url, external_ids)
      VALUES (?,?,?,?,?)`)
    .run(rawName, normalized, country || null, extra.badge_url || null, JSON.stringify(ext));
  return r.lastInsertRowid;
}

export function upsertReferee(name) {
  if (!name || !name.trim()) return null;
  db.prepare(`INSERT OR IGNORE INTO referees (name) VALUES (?)`).run(name.trim());
  return db.prepare(`SELECT id FROM referees WHERE name=?`).get(name.trim()).id;
}

export function upsertVenue(name, city, country) {
  if (!name) return null;
  db.prepare(`INSERT OR IGNORE INTO venues (name, city, country) VALUES (?,?,?)`)
    .run(name, city || null, country || null);
  return db.prepare(`SELECT id FROM venues WHERE name=? AND (country=? OR country IS NULL)`)
    .get(name, country || null)?.id || null;
}

/**
 * DATA FUSION ENGINE (§6, §7) — upsert d'un match avec fusion multi-sources.
 * - Un match identique (compétition, saison, équipes, ±1 jour) provenant d'une
 *   nouvelle source enrichit source_ids → validation croisée.
 * - Deux sources en désaccord sur le score → DATA CONFLICT enregistré, la donnée
 *   n'est PAS écrasée arbitrairement (règle de résolution : source la plus fiable,
 *   documentée dans data_conflicts.resolution_rule).
 */
export function upsertFixture(f) {
  // f: { competitionId, seasonCode, homeTeamId, awayTeamId, kickoffUtc, status,
  //      homeScore, awayScore, htHome, htAway, refereeId, venueId, round,
  //      sourceId, externalId, dataTag }
  const dayStart = f.kickoffUtc ? f.kickoffUtc.slice(0, 10) : null;
  const existing = db.prepare(`SELECT * FROM fixtures
      WHERE competition_id=? AND home_team_id=? AND away_team_id=?
      AND date(kickoff_utc) BETWEEN date(?, '-1 day') AND date(?, '+1 day')`)
    .get(f.competitionId, f.homeTeamId, f.awayTeamId, dayStart, dayStart);

  if (existing) {
    const sources = new Set(JSON.parse(existing.source_ids || '[]'));
    const isNewSource = !sources.has(f.sourceId);
    sources.add(f.sourceId);
    const ext = JSON.parse(existing.external_ids || '{}');
    if (f.externalId) ext[f.sourceId] = f.externalId;

    // Détection de conflit de score entre sources (§6, §73)
    let validation = existing.validation_status;
    if (existing.home_score != null && f.homeScore != null &&
        (existing.home_score !== f.homeScore || existing.away_score !== f.awayScore)) {
      validation = 'DATA CONFLICT';
      db.prepare(`INSERT INTO data_conflicts (entity_type, entity_id, field, values_json, detected_at, resolution_rule)
          VALUES ('fixture', ?, 'score', ?, ?, 'conserver la valeur de la source au reliability_score le plus élevé ; conflit exposé à l''UI')`)
        .run(existing.id, JSON.stringify({
          existing: { sources: [...sources].filter((s) => s !== f.sourceId), score: `${existing.home_score}-${existing.away_score}` },
          incoming: { source: f.sourceId, score: `${f.homeScore}-${f.awayScore}` },
        }), now());
      // règle documentée : ne pas écraser ; garder l'existant, marquer le conflit
      db.prepare(`UPDATE fixtures SET source_ids=?, external_ids=?, validation_status=?, updated_at=? WHERE id=?`)
        .run(JSON.stringify([...sources]), JSON.stringify(ext), validation, now(), existing.id);
      return { id: existing.id, conflict: true };
    }

    // accord entre ≥2 sources sur un score final → VERIFIED (§6)
    if (isNewSource && f.homeScore != null && existing.home_score === f.homeScore &&
        existing.away_score === f.awayScore && sources.size >= 2) {
      validation = 'VERIFIED';
    }
    db.prepare(`UPDATE fixtures SET
        status=COALESCE(?, status),
        home_score=COALESCE(?, home_score), away_score=COALESCE(?, away_score),
        ht_home=COALESCE(?, ht_home), ht_away=COALESCE(?, ht_away),
        referee_id=COALESCE(?, referee_id), venue_id=COALESCE(?, venue_id),
        round=COALESCE(?, round), kickoff_utc=COALESCE(?, kickoff_utc),
        source_ids=?, external_ids=?, validation_status=?, updated_at=?
        WHERE id=?`)
      .run(f.status || null, f.homeScore ?? null, f.awayScore ?? null,
        f.htHome ?? null, f.htAway ?? null, f.refereeId || null, f.venueId || null,
        f.round || null, f.kickoffUtc || null,
        JSON.stringify([...sources]), JSON.stringify(ext), validation, now(), existing.id);
    return { id: existing.id, conflict: false };
  }

  const r = db.prepare(`INSERT INTO fixtures
      (competition_id, season_code, home_team_id, away_team_id, kickoff_utc, status,
       home_score, away_score, ht_home, ht_away, referee_id, venue_id, round,
       source_ids, external_ids, data_tag, validation_status, retrieved_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.competitionId, f.seasonCode || null, f.homeTeamId, f.awayTeamId,
      f.kickoffUtc || null, f.status || 'SCHEDULED',
      f.homeScore ?? null, f.awayScore ?? null, f.htHome ?? null, f.htAway ?? null,
      f.refereeId || null, f.venueId || null, f.round || null,
      JSON.stringify([f.sourceId]),
      JSON.stringify(f.externalId ? { [f.sourceId]: f.externalId } : {}),
      f.dataTag || 'SOURCE DATA', 'UNVERIFIED', now(), now());
  return { id: r.lastInsertRowid, conflict: false };
}

export function saveTeamStats(fixtureId, side, stats, sourceId) {
  db.prepare(`INSERT INTO team_statistics
      (fixture_id, team_side, shots, shots_on_target, fouls, corners, yellow, red, source_id, retrieved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fixture_id, team_side) DO UPDATE SET
      shots=excluded.shots, shots_on_target=excluded.shots_on_target, fouls=excluded.fouls,
      corners=excluded.corners, yellow=excluded.yellow, red=excluded.red, retrieved_at=excluded.retrieved_at`)
    .run(fixtureId, side, stats.shots ?? null, stats.shotsOnTarget ?? null,
      stats.fouls ?? null, stats.corners ?? null, stats.yellow ?? null, stats.red ?? null,
      sourceId, now());
}

export function saveOdds(fixtureId, bookmakerCode, marketCode, selection, price, sourceId) {
  if (!price || !(price > 1)) return;
  db.prepare(`INSERT OR IGNORE INTO bookmakers (code, name) VALUES (?,?)`).run(bookmakerCode, bookmakerCode);
  db.prepare(`INSERT OR IGNORE INTO markets (code, name) VALUES (?,?)`).run(marketCode, marketCode);
  const prev = db.prepare(`SELECT price FROM odds WHERE fixture_id=? AND bookmaker_code=? AND market_code=? AND selection=?`)
    .get(fixtureId, bookmakerCode, marketCode, selection);
  db.prepare(`INSERT INTO odds (fixture_id, bookmaker_code, market_code, selection, price, source_id, retrieved_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(fixture_id, bookmaker_code, market_code, selection) DO UPDATE SET
      price=excluded.price, retrieved_at=excluded.retrieved_at`)
    .run(fixtureId, bookmakerCode, marketCode, selection, price, sourceId, now());
  // Historique des cotes (§38) : snapshot uniquement si la valeur change
  if (!prev || Math.abs(prev.price - price) > 1e-9) {
    db.prepare(`INSERT INTO odds_snapshots (fixture_id, bookmaker_code, market_code, selection, price, source_id, snapshot_at)
        VALUES (?,?,?,?,?,?,?)`)
      .run(fixtureId, bookmakerCode, marketCode, selection, price, sourceId, now());
  }
}
