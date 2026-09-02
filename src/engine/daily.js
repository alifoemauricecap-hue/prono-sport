// PRONO SPORT — DAILY SELECTIONS ENGINE
// Pronostic Expert du jour + Combiné Safe du jour + bilans quotidiens/hebdo
// + leçons du modèle (apprentissage sur résultats réels).
//
// Règles d'honnêteté :
// - Une sélection n'existe que si des pronostics qualifiés existent ce jour-là
//   (états vides honnêtes sinon) ;
// - Probabilité combinée = produit des probabilités individuelles du modèle,
//   sous hypothèse d'indépendance (affichée comme MODEL ESTIMATE) ;
// - Une sélection est VERROUILLÉE au coup d'envoi de son premier match :
//   plus aucune modification ensuite (§34, §54) ;
// - Les leçons sont des constats CHIFFRÉS sur les résultats réels — jamais
//   de conclusion sans échantillon suffisant.
import { db, now, notify } from '../db.js';
import { CONFIG } from '../config.js';
import { evaluateSelection } from './predictions.js';

const EXPERT_MIN_PROB = 0.62;   // seuil « expert » : forte probabilité modèle
const EXPERT_MAX_LEGS = 6;
const COMBO_TARGET_ODDS = 3.0;  // cote totale visée
const COMBO_ODDS_MIN = 2.5;
const COMBO_ODDS_MAX = 3.6;
const COMBO_MAX_LEGS = 4;

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Pronostics candidats d'un jour donné : qualifiés, pré-match, non réglés. */
function dayCandidates(day) {
  return db.prepare(`SELECT p.id AS prediction_id, p.fixture_id, p.market, p.selection,
      p.probability, p.odds, p.confidence, p.data_quality, p.decision,
      f.kickoff_utc, f.status,
      c.code AS comp_code, c.name AS comp_name,
      ht.name AS home_name, at2.name AS away_name
      FROM predictions p
      JOIN fixtures f ON f.id=p.fixture_id
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE date(f.kickoff_utc)=? AND p.decision IN ('PICK','VALUE BET')
        AND p.result='PENDING' AND f.status IN ('SCHEDULED','UPCOMING')
        AND f.kickoff_utc > datetime('now')
      ORDER BY p.probability DESC`).all(day)
    // 1 seul pronostic par match (le plus probable)
    .filter((r, i, arr) => arr.findIndex((x) => x.fixture_id === r.fixture_id) === i);
}

/** EXPERT DU JOUR : les pronostics à plus forte probabilité de validation. */
function buildExpertLegs(day) {
  const shrink = getCalibrationShrink();
  return dayCandidates(day)
    .map((c) => ({ ...c, adjusted: round4(c.probability * shrink) }))
    .filter((c) => c.adjusted >= EXPERT_MIN_PROB && c.data_quality >= CONFIG.value.minDataQuality)
    .slice(0, EXPERT_MAX_LEGS);
}

/** COMBINÉ SAFE : sous-ensemble maximisant la probabilité combinée,
 *  avec une cote totale la plus proche possible de 3. Recherche exhaustive
 *  bornée (≤ 12 candidats, ≤ 4 jambes) — déterministe et auditable. */
function buildComboLegs(day) {
  const shrink = getCalibrationShrink();
  const pool = dayCandidates(day)
    .map((c) => ({ ...c, adjusted: round4(c.probability * shrink) }))
    .filter((c) => c.odds && c.odds > 1.05 && c.data_quality >= CONFIG.value.minDataQuality)
    .sort((a, b) => b.adjusted - a.adjusted)
    .slice(0, 12);
  let best = null;
  const n = pool.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const legs = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) legs.push(pool[i]);
    if (legs.length < 2 || legs.length > COMBO_MAX_LEGS) continue;
    const odds = legs.reduce((a, l) => a * l.odds, 1);
    if (odds < COMBO_ODDS_MIN || odds > COMBO_ODDS_MAX) continue;
    const prob = legs.reduce((a, l) => a * l.adjusted, 1);
    const score = prob - Math.abs(odds - COMBO_TARGET_ODDS) * 0.01; // priorité probabilité, cote ~3 en départage
    if (!best || score > best.score) best = { legs, odds: round2(odds), prob: round4(prob), score };
  }
  return best;
}

function legPayload(c) {
  return {
    prediction_id: c.prediction_id, fixture_id: c.fixture_id,
    market: c.market, selection: c.selection,
    probability: c.probability, adjusted_probability: c.adjusted ?? c.probability,
    odds: c.odds, kickoff_utc: c.kickoff_utc,
    home_name: c.home_name, away_name: c.away_name,
    comp_code: c.comp_code, comp_name: c.comp_name,
    result: 'PENDING',
  };
}

/** Crée ou reconstruit les sélections OPEN du jour (jamais une sélection LOCKED). */
export function ensureDailySelections(day = todayUtc()) {
  const out = { day };
  // EXPERT
  const exRow = db.prepare(`SELECT * FROM daily_selections WHERE day=? AND type='EXPERT'`).get(day);
  if (!exRow || exRow.status === 'OPEN') {
    const legs = buildExpertLegs(day).map(legPayload);
    if (legs.length) {
      const prob = round4(legs.reduce((a, l) => a * l.adjusted_probability, 1));
      db.prepare(`INSERT INTO daily_selections (day, type, status, legs_json, combined_odds, combined_probability, created_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(day, type) DO UPDATE SET legs_json=excluded.legs_json,
            combined_odds=excluded.combined_odds, combined_probability=excluded.combined_probability
          WHERE daily_selections.status='OPEN'`)
        .run(day, 'EXPERT', 'OPEN', JSON.stringify(legs),
          round2(legs.reduce((a, l) => a * (l.odds || 1), 1)), prob, now());
      out.expert = legs.length;
    }
  }
  // COMBINÉ SAFE
  const cbRow = db.prepare(`SELECT * FROM daily_selections WHERE day=? AND type='SAFE_COMBO'`).get(day);
  if (!cbRow || cbRow.status === 'OPEN') {
    const combo = buildComboLegs(day);
    if (combo) {
      db.prepare(`INSERT INTO daily_selections (day, type, status, legs_json, combined_odds, combined_probability, created_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(day, type) DO UPDATE SET legs_json=excluded.legs_json,
            combined_odds=excluded.combined_odds, combined_probability=excluded.combined_probability
          WHERE daily_selections.status='OPEN'`)
        .run(day, 'SAFE_COMBO', 'OPEN', JSON.stringify(combo.legs.map(legPayload)), combo.odds, combo.prob, now());
      out.combo = combo.legs.length;
    }
  }
  return out;
}

/** Verrouille les sélections dont le premier match a commencé, puis règle
 *  celles dont tous les matchs sont terminés. */
export function lockAndSettleSelections() {
  let locked = 0, settled = 0;
  for (const sel of db.prepare(`SELECT * FROM daily_selections WHERE status IN ('OPEN','LOCKED')`).all()) {
    const legs = JSON.parse(sel.legs_json);
    if (!legs.length) continue;
    // verrouillage au premier coup d'envoi
    if (sel.status === 'OPEN') {
      const firstKick = Math.min(...legs.map((l) => new Date(l.kickoff_utc).getTime()));
      if (Date.now() >= firstKick) {
        db.prepare(`UPDATE daily_selections SET status='LOCKED', locked_at=? WHERE id=?`).run(now(), sel.id);
        sel.status = 'LOCKED'; locked++;
      }
    }
    if (sel.status !== 'LOCKED') continue;
    // règlement jambe par jambe sur les scores réels
    let allDone = true, anyLoss = false, allVoid = true;
    for (const leg of legs) {
      if (leg.result === 'PENDING') {
        const f = db.prepare(`SELECT status, home_score, away_score FROM fixtures WHERE id=?`).get(leg.fixture_id);
        if (['CANCELLED', 'POSTPONED', 'ABANDONED'].includes(f?.status)) leg.result = 'VOID';
        else if (f?.status === 'FINISHED' && f.home_score != null) {
          const won = evaluateSelection(leg.market, leg.selection, f.home_score, f.away_score);
          leg.result = won == null ? 'VOID' : won ? 'WIN' : 'LOSS';
        }
      }
      if (leg.result === 'PENDING') allDone = false;
      if (leg.result === 'LOSS') anyLoss = true;
      if (leg.result !== 'VOID') allVoid = false;
    }
    db.prepare(`UPDATE daily_selections SET legs_json=? WHERE id=?`).run(JSON.stringify(legs), sel.id);
    if (anyLoss || allDone) {
      const status = anyLoss ? 'LOST' : allVoid ? 'VOID' : 'WON';
      db.prepare(`UPDATE daily_selections SET status=?, settled_at=? WHERE id=?`).run(status, now(), sel.id);
      settled++;
      notify('DAILY_SELECTION_SETTLED', { day: sel.day, type: sel.type, status });
    }
  }
  return { locked, settled };
}

export function getDailySelection(day, type) {
  const row = db.prepare(`SELECT * FROM daily_selections WHERE day=? AND type=?`).get(day, type);
  if (!row) return null;
  return { ...row, legs: JSON.parse(row.legs_json), legs_json: undefined };
}

/** Bilan d'un jour : pronostics individuels + sélections du jour. */
export function dailyStats(day = todayUtc()) {
  const rows = db.prepare(`SELECT p.result, COUNT(*) AS n
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE date(f.kickoff_utc)=? AND p.decision IN ('PICK','VALUE BET')
      GROUP BY p.result`).all(day);
  const counts = { WIN: 0, LOSS: 0, VOID: 0, PENDING: 0 };
  for (const r of rows) counts[r.result] = r.n;
  const settledN = counts.WIN + counts.LOSS;
  return {
    day, counts,
    win_rate: settledN ? round4(counts.WIN / settledN) : null,
    expert: getDailySelection(day, 'EXPERT'),
    combo: getDailySelection(day, 'SAFE_COMBO'),
    data_tag: 'CALCULATED DATA',
  };
}

/** Bilan hebdomadaire (lundi→dimanche) + performance des sélections. */
export function weeklyStats(weeksBack = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7 * weeksBack);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lundi
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow);
  const from = monday.toISOString().slice(0, 10);
  const to = new Date(monday.getTime() + 6 * 86400_000).toISOString().slice(0, 10);
  const preds = db.prepare(`SELECT p.result, COUNT(*) AS n, AVG(p.probability) AS avg_p,
      SUM(CASE WHEN p.result='WIN' THEN p.odds-1 WHEN p.result='LOSS' THEN -1 ELSE 0 END) AS units
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE date(f.kickoff_utc) BETWEEN ? AND ? AND p.decision IN ('PICK','VALUE BET')
      GROUP BY p.result`).all(from, to);
  const perMarket = db.prepare(`SELECT p.market, p.result, COUNT(*) AS n
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE date(f.kickoff_utc) BETWEEN ? AND ? AND p.result IN ('WIN','LOSS')
      GROUP BY p.market, p.result`).all(from, to);
  const selections = db.prepare(`SELECT type, status, COUNT(*) AS n FROM daily_selections
      WHERE day BETWEEN ? AND ? GROUP BY type, status`).all(from, to);
  const days = db.prepare(`SELECT date(f.kickoff_utc) AS day, p.result, COUNT(*) AS n
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE date(f.kickoff_utc) BETWEEN ? AND ? AND p.decision IN ('PICK','VALUE BET')
      GROUP BY day, p.result ORDER BY day`).all(from, to);
  return { from, to, predictions: preds, per_market: perMarket, selections, per_day: days, data_tag: 'CALCULATED DATA' };
}

/* ============ APPRENTISSAGE : leçons chiffrées + calibration ============ */

/** Facteur de calibration appliqué aux sélections du jour (jamais > 1).
 *  Calculé sur les résultats réels ; 1.0 tant que l'échantillon est trop petit. */
export function getCalibrationShrink() {
  const v = db.prepare(`SELECT value FROM kv WHERE key='calibration_shrink'`).get();
  const x = v ? parseFloat(v.value) : 1;
  return Number.isFinite(x) ? Math.min(1, Math.max(0.85, x)) : 1;
}

/** Calcule les leçons de la période : calibration par tranche de probabilité,
 *  par marché — et ajuste le facteur de prudence si un biais est PROUVÉ. */
export function computeLessons() {
  const period = isoWeek(new Date());
  const lessons = [];
  const buckets = db.prepare(`SELECT
      CASE WHEN probability>=0.75 THEN '75+' WHEN probability>=0.65 THEN '65-75'
           WHEN probability>=0.55 THEN '55-65' ELSE '<55' END AS bucket,
      COUNT(*) AS n, SUM(result='WIN') AS wins, AVG(probability) AS avg_p
      FROM predictions WHERE result IN ('WIN','LOSS') GROUP BY bucket`).all();
  let worstGap = 0;
  for (const b of buckets) {
    const realRate = b.wins / b.n;
    const gap = round4(realRate - b.avg_p);
    const enough = b.n >= 30;
    lessons.push({
      scope: `bucket:${b.bucket}`,
      observation: `Probabilité annoncée moyenne ${(b.avg_p * 100).toFixed(1)}% → taux réel ${(realRate * 100).toFixed(1)}% (${b.wins}/${b.n}).`,
      sample_size: b.n,
      adjustment: enough
        ? (gap < -0.05 ? `Surconfiance détectée (${(gap * 100).toFixed(1)} pts) → facteur de prudence appliqué aux sélections du jour.` : 'Calibration correcte — aucun ajustement.')
        : 'AUCUNE — échantillon insuffisant (min. 30 réglés).',
    });
    if (enough && gap < worstGap) worstGap = gap;
  }
  const markets = db.prepare(`SELECT market, COUNT(*) AS n, SUM(result='WIN') AS wins, AVG(probability) AS avg_p
      FROM predictions WHERE result IN ('WIN','LOSS') GROUP BY market`).all();
  for (const m of markets) {
    lessons.push({
      scope: `market:${m.market}`,
      observation: `${m.wins}/${m.n} validés (${((m.wins / m.n) * 100).toFixed(1)}%) — probabilité annoncée moyenne ${(m.avg_p * 100).toFixed(1)}%.`,
      sample_size: m.n,
      adjustment: m.n >= 30 && m.wins / m.n < m.avg_p - 0.08
        ? `Marché sous-performant — poids réduit dans les sélections du jour.`
        : (m.n >= 30 ? 'Performance conforme.' : 'AUCUNE — échantillon insuffisant (min. 30 réglés).'),
    });
  }
  // application PRUDENTE : shrink borné [0.85, 1], uniquement si biais prouvé
  const shrink = worstGap < -0.05 ? Math.max(0.85, 1 + worstGap) : 1;
  db.prepare(`INSERT INTO kv (key, value) VALUES ('calibration_shrink', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(round4(shrink)));
  const ins = db.prepare(`INSERT INTO model_lessons (computed_at, period, scope, observation, sample_size, adjustment)
      VALUES (?,?,?,?,?,?)`);
  db.prepare(`DELETE FROM model_lessons WHERE period=?`).run(period); // recalcul idempotent de la période
  for (const l of lessons) ins.run(now(), period, l.scope, l.observation, l.sample_size, l.adjustment);
  return { period, lessons: lessons.length, shrink };
}

export function getLessons(limit = 40) {
  return db.prepare(`SELECT * FROM model_lessons ORDER BY computed_at DESC, id ASC LIMIT ?`).all(limit);
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
