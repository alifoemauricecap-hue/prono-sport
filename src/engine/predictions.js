// PRONO SPORT — PREDICTION ENGINE (orchestrateur)
// Chaîne §99 : REAL DATA → VALIDATION → FUSION → QUALITY → FEATURES → MODÈLES
// → CALIBRATION → MARCHÉ → PROBABILITÉ → VALUE → RISQUE → DÉCISION
// Piste d'audit complète (§56), pronostics immuables (§54).
import { db, now, notify } from '../db.js';
import { CONFIG } from '../config.js';
import { trainCompetition, predictFixture } from './models.js';
import { analyzeMarkets, computeDataQuality, modelConfidence } from './value.js';

const modelCache = new Map(); // competitionId -> { model, trainedAt }
const MODEL_TTL = 6 * 3600_000;

export function getCompetitionModel(competitionId, force = false) {
  const cached = modelCache.get(competitionId);
  if (!force && cached && Date.now() - cached.trainedAt < MODEL_TTL) return cached.model;
  const model = trainCompetition(competitionId);
  modelCache.set(competitionId, { model, trainedAt: Date.now() });
  if (model?.backtest) {
    db.prepare(`INSERT INTO model_versions (version, description, trained_at, training_matches,
        backtest_brier, backtest_logloss, weights, calibration_json, value_json)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(version) DO UPDATE SET trained_at=excluded.trained_at,
        training_matches=excluded.training_matches, backtest_brier=excluded.backtest_brier,
        backtest_logloss=excluded.backtest_logloss, weights=excluded.weights,
        calibration_json=excluded.calibration_json, value_json=excluded.value_json`)
      .run(`${CONFIG.modelVersion}-comp${competitionId}`,
        'Ensemble Elo + Poisson + Dixon-Coles, poids validés par walk-forward',
        now(), model.matches,
        model.backtest.ensemble.brier, model.backtest.ensemble.logloss,
        JSON.stringify(model.backtest.ensemble.weights),
        JSON.stringify(model.backtest.calibration || null),
        JSON.stringify(model.backtest.value || null));
  }
  return model;
}

/** Génère (ou régénère) l'analyse d'un match à venir. */
export function generatePrediction(fixtureId) {
  const f = db.prepare(`SELECT * FROM fixtures WHERE id=?`).get(fixtureId);
  if (!f) return { status: 'NOT_FOUND' };
  if (f.status === 'FINISHED') return { status: 'ALREADY_FINISHED' };

  const model = getCompetitionModel(f.competition_id);
  if (!model) return { status: 'INSUFFICIENT DATA', reason: 'Historique de compétition insuffisant pour entraîner les modèles (min. 60 matchs réels).' };

  const pred = predictFixture(model, f.home_team_id, f.away_team_id);
  if (!pred) return { status: 'INSUFFICIENT DATA', reason: `Profondeur d'historique insuffisante pour une des équipes (min. ${CONFIG.value.minMatchesPerTeam} matchs réels).` };

  // sorties par modèle (transparence §85)
  const upsertOutput = db.prepare(`INSERT INTO model_outputs
      (fixture_id, model_name, model_version, p_home, p_draw, p_away, lambda_home, lambda_away, computed_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fixture_id, model_name, model_version) DO UPDATE SET
      p_home=excluded.p_home, p_draw=excluded.p_draw, p_away=excluded.p_away,
      lambda_home=excluded.lambda_home, lambda_away=excluded.lambda_away, computed_at=excluded.computed_at`);
  for (const [name, p] of Object.entries(pred.perModel)) {
    upsertOutput.run(fixtureId, name, CONFIG.modelVersion, p.home, p.draw, p.away,
      pred.lambdas.home, pred.lambdas.away, now());
  }
  upsertOutput.run(fixtureId, 'ensemble', CONFIG.modelVersion,
    pred.ensemble.home, pred.ensemble.draw, pred.ensemble.away,
    pred.lambdas.home, pred.lambdas.away, now());

  const oddsBooks = db.prepare(`SELECT COUNT(DISTINCT bookmaker_code) AS n FROM odds
      WHERE fixture_id=? AND bookmaker_code NOT IN ('Max','Avg')`).get(fixtureId).n;
  const sourceCount = JSON.parse(f.source_ids || '[]').length;
  const dq = computeDataQuality(f, pred.depth, oddsBooks, sourceCount);
  const confidence = modelConfidence(model.backtest, pred.depth);

  db.prepare(`INSERT INTO data_quality (entity_type, entity_id, score, components, computed_at)
      VALUES ('fixture', ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET score=excluded.score,
      components=excluded.components, computed_at=excluded.computed_at`)
    .run(fixtureId, dq.score, JSON.stringify(dq.components), now());

  const analysis = analyzeMarkets(fixtureId, pred.markets, dq.score, confidence);

  // Enregistrement du pronostic — IMMUABLE une fois créé (§54) :
  // on ne modifie jamais un pronostic existant ; on ajoute un snapshot.
  // GARDE TEMPORELLE (§34) : un pronostic n'entre dans l'audit trail QUE si
  // le coup d'envoi est dans le futur — jamais de pronostic post-kickoff.
  const isPreMatch = new Date(f.kickoff_utc).getTime() > Date.now();
  if (analysis.best && isPreMatch) {
    const b = analysis.best;
    const existing = db.prepare(`SELECT id, result FROM predictions
        WHERE fixture_id=? AND market=? AND selection=? AND model_version=?`)
      .get(fixtureId, b.market, b.selection, CONFIG.modelVersion);
    if (!existing) {
      const r = db.prepare(`INSERT INTO predictions
          (fixture_id, created_at, model_version, features_version, market, selection,
           probability, market_probability, odds, fair_odds, edge, ev, confidence,
           data_quality, decision, rationale)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(fixtureId, now(), CONFIG.modelVersion, CONFIG.featuresVersion,
          b.market, b.selection, b.pModel, b.pMarket, b.bestPrice, b.fairOdds,
          b.edge, b.ev, confidence, dq.score, analysis.decision,
          analysis.note || `Meilleure cote ${b.bestPrice} (${b.bestBook}) vs fair odds ${b.fairOdds}. Edge ${(b.edge * 100).toFixed(1)}%, EV ${(b.ev * 100).toFixed(1)}%.`);
      if (analysis.decision === 'VALUE BET') {
        db.prepare(`INSERT OR IGNORE INTO value_bets
            (prediction_id, fixture_id, edge, ev, best_bookmaker, best_price, avg_price, created_at)
            VALUES (?,?,?,?,?,?,?,?)`)
          .run(r.lastInsertRowid, fixtureId, b.edge, b.ev, b.bestBook, b.bestPrice, b.avgPrice, now());
        notify('VALUE_BET', { fixtureId, market: b.market, selection: b.selection, edge: b.edge, ev: b.ev });
      }
    } else {
      db.prepare(`INSERT INTO prediction_snapshots (prediction_id, snapshot_at, payload) VALUES (?,?,?)`)
        .run(existing.id, now(), JSON.stringify(b));
    }
  }
  return {
    status: 'OK', prediction: pred, analysis, dataQuality: dq, confidence,
    backtest: model.backtest ? {
      nTest: model.backtest.nTest,
      models: model.backtest.models,
      ensemble: model.backtest.ensemble,
    } : null,
  };
}

/** Settlement (§17, §54) : évalue les pronostics des matchs terminés. */
export function settlePredictions() {
  const pending = db.prepare(`SELECT p.*, f.home_score, f.away_score, f.status AS fstatus
      FROM predictions p JOIN fixtures f ON f.id=p.fixture_id
      WHERE p.result='PENDING'`).all();
  let settled = 0;
  for (const p of pending) {
    if (p.fstatus === 'CANCELLED' || p.fstatus === 'POSTPONED' || p.fstatus === 'ABANDONED') {
      db.prepare(`UPDATE predictions SET result='VOID', settled_at=? WHERE id=?`).run(now(), p.id);
      settled++; continue;
    }
    if (p.fstatus !== 'FINISHED' || p.home_score == null) continue;
    const won = evaluateSelection(p.market, p.selection, p.home_score, p.away_score);
    if (won == null) continue;
    db.prepare(`UPDATE predictions SET result=?, settled_at=? WHERE id=?`)
      .run(won ? 'WIN' : 'LOSS', now(), p.id);
    settled++;
  }
  return settled;
}

export function evaluateSelection(market, selection, hs, as) {
  switch (market) {
    case '1X2':
      return selection === 'HOME' ? hs > as : selection === 'AWAY' ? as > hs : hs === as;
    case 'DC':
      return selection === '1X' ? hs >= as : selection === 'X2' ? as >= hs : hs !== as;
    case 'OU2.5':
      return selection === 'OVER' ? hs + as > 2.5 : hs + as < 2.5;
    case 'BTTS':
      return selection === 'YES' ? hs > 0 && as > 0 : hs === 0 || as === 0;
    default: {
      // HANDICAPS ASIATIQUES demi-lignes : 'AH-0.5', 'AH+0.5', 'AH-1.5', 'AH+1.5'
      const ah = /^AH([+-]\d+(?:\.\d+)?)$/.exec(market);
      if (ah) {
        const line = parseFloat(ah[1]);
        return selection === 'HOME' ? hs + line - as > 0 : hs + line - as < 0;
      }
      return null;
    }
  }
}

/** Track record réel (paper tracking §55) — jamais de taux fictif. */
export function trackRecord() {
  const rows = db.prepare(`SELECT decision, result, COUNT(*) AS n,
      AVG(odds) AS avg_odds, SUM(CASE WHEN result='WIN' THEN odds-1 WHEN result='LOSS' THEN -1 ELSE 0 END) AS units
      FROM predictions WHERE result IN ('WIN','LOSS','VOID')
      GROUP BY decision, result`).all();
  const pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE result='PENDING'`).get().n;
  return { settled: rows, pending: pendingCount, note: 'PAPER TRACKING — pronostics enregistrés avant match, jamais modifiés rétroactivement.' };
}
