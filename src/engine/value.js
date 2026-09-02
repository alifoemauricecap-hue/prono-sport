// PRONO SPORT — VALUE BET ENGINE (§40-§44) + DATA QUALITY (§47) + MODEL CONFIDENCE (§48)
//
// Formules documentées (§40) :
//   implied probability (brute)  = 1 / cote
//   marge du bookmaker           = Σ (1/cote_i) - 1
//   implied probability (sans marge, normalisée) = (1/cote) / Σ(1/cote_i)
//   fair odds  = 1 / P_modèle
//   edge       = P_modèle - P_marché(sans marge)
//   EV         = (P_modèle × cote) - 1
//
// AUCUN pronostic par défaut (§44) : tous les marchés disponibles sont analysés,
// et si aucun ne passe les critères → NO QUALIFIED PICK (§41).
import { db, now } from '../db.js';
import { CONFIG } from '../config.js';

export function impliedProbabilities(prices) {
  // prices: { SEL: cote }
  const inv = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, 1 / v]));
  const overround = Object.values(inv).reduce((a, b) => a + b, 0);
  const fair = Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / overround]));
  return { raw: inv, overround, fair };
}

/** Cotes agrégées d'un match par marché : meilleure, moyenne, par bookmaker */
export function aggregatedOdds(fixtureId, marketCode) {
  const rows = db.prepare(`SELECT bookmaker_code, selection, price, retrieved_at
      FROM odds WHERE fixture_id=? AND market_code=? AND status='ACTIVE'`)
    .all(fixtureId, marketCode);
  if (!rows.length) return null;
  const bySel = {};
  for (const r of rows) {
    // Max/Avg sont des agrégats publiés par la source, séparés des books individuels
    if (!bySel[r.selection]) bySel[r.selection] = { prices: [], best: null, avgPublished: null, maxPublished: null };
    if (r.bookmaker_code === 'Avg') bySel[r.selection].avgPublished = r.price;
    else if (r.bookmaker_code === 'Max') bySel[r.selection].maxPublished = r.price;
    else {
      bySel[r.selection].prices.push({ book: r.bookmaker_code, price: r.price });
      if (!bySel[r.selection].best || r.price > bySel[r.selection].best.price) {
        bySel[r.selection].best = { book: r.bookmaker_code, price: r.price };
      }
    }
  }
  for (const sel of Object.keys(bySel)) {
    const s = bySel[sel];
    s.avg = s.avgPublished ?? (s.prices.length
      ? s.prices.reduce((a, p) => a + p.price, 0) / s.prices.length : null);
    s.bestPrice = s.maxPublished && (!s.best || s.maxPublished > s.best.price)
      ? { book: 'Marché (max)', price: s.maxPublished } : s.best;
    s.dispersion = s.prices.length > 1
      ? Math.max(...s.prices.map((p) => p.price)) - Math.min(...s.prices.map((p) => p.price)) : 0;
  }
  return bySel;
}

/** DATA QUALITY SCORE (§47) — composantes observables uniquement */
export function computeDataQuality(fixture, modelDepth, oddsBooks, sourceCount) {
  const c = {};
  // fraîcheur des cotes
  const lastOdds = db.prepare(`SELECT MAX(retrieved_at) AS t FROM odds WHERE fixture_id=?`).get(fixture.id)?.t;
  const ageH = lastOdds ? (Date.now() - new Date(lastOdds).getTime()) / 3600_000 : null;
  c.freshness = ageH == null ? 0 : ageH < 6 ? 1 : ageH < 24 ? 0.7 : ageH < 72 ? 0.4 : 0.2;
  // profondeur d'historique par équipe
  const depth = modelDepth ? Math.min(modelDepth.home, modelDepth.away) : 0;
  c.coverage = Math.min(1, depth / 30);
  // nombre de sources croisées sur le match
  c.sources = Math.min(1, (sourceCount || 1) / 2);
  // nombre de bookmakers réels
  c.market = Math.min(1, (oddsBooks || 0) / 5);
  // cohérence : pénalité si conflit détecté
  c.consistency = fixture.validation_status === 'DATA CONFLICT' ? 0 : 1;
  const score = 0.25 * c.freshness + 0.3 * c.coverage + 0.15 * c.sources + 0.15 * c.market + 0.15 * c.consistency;
  return { score: Math.round(score * 100) / 100, components: c };
}

/** MODEL CONFIDENCE (§48) — distincte de la qualité de données */
export function modelConfidence(backtest, depth) {
  if (!backtest) return 0.3;
  // log-loss de référence d'un modèle uniforme 1X2 = ln(3) ≈ 1.0986
  const skill = Math.max(0, Math.min(1, (1.0986 - backtest.ensemble.logloss) / 0.25));
  const depthFactor = Math.min(1, (depth ? Math.min(depth.home, depth.away) : 0) / 25);
  return Math.round((0.6 * skill + 0.4 * depthFactor) * 100) / 100;
}

/**
 * Analyse tous les marchés disponibles d'un match et retourne :
 * { decision: 'VALUE BET'|'PICK'|'NO QUALIFIED PICK', best, candidates, noBetReason }
 */
export function analyzeMarkets(fixtureId, marketProbs, dataQuality, confidence) {
  const cfg = CONFIG.value;
  const candidates = [];
  for (const [marketCode, sels] of Object.entries(marketProbs)) {
    const agg = aggregatedOdds(fixtureId, marketCode);
    if (!agg) continue; // marché non coté par les sources → non analysable (§42)
    const prices = {};
    for (const sel of Object.keys(sels)) {
      if (agg[sel]?.avg) prices[sel] = agg[sel].avg;
    }
    if (Object.keys(prices).length < Object.keys(sels).length) continue;
    const implied = impliedProbabilities(prices);
    for (const [sel, pModel] of Object.entries(sels)) {
      const oddsInfo = agg[sel];
      if (!oddsInfo?.bestPrice) continue;
      const pMarket = implied.fair[sel];
      const bestPrice = oddsInfo.bestPrice.price;
      const edge = pModel - pMarket;
      const ev = pModel * bestPrice - 1;
      candidates.push({
        market: marketCode, selection: sel,
        pModel: round4(pModel), pMarket: round4(pMarket),
        fairOdds: round2(1 / pModel),
        bestPrice: round2(bestPrice), bestBook: oddsInfo.bestPrice.book,
        avgPrice: round2(prices[sel]), overround: round4(implied.overround),
        edge: round4(edge), ev: round4(ev),
        dispersion: round2(oddsInfo.dispersion || 0),
        qualifies: edge >= cfg.minEdge && ev >= cfg.minEV && pModel >= cfg.minModelProb
          && dataQuality >= cfg.minDataQuality,
      });
    }
  }
  candidates.sort((a, b) => b.ev - a.ev);
  const qualified = candidates.filter((c) => c.qualifies);
  if (!candidates.length) {
    // AUCUN MARCHÉ COTÉ (§v3.3) : au lieu d'abandonner, on publie le
    // PRONOSTIC D'ANALYSE — le marché le plus probable issu du modèle calibré,
    // avec sa cote équitable 1/p. Étiquette MODEL ESTIMATE, jamais présenté
    // comme une cote bookmaker. Seuils : p ≥ 0,58 et qualité de données OK.
    const ANALYSIS_MIN_PROB = 0.58;
    let ap = null;
    for (const [marketCode, sels] of Object.entries(marketProbs)) {
      for (const [sel, pModel] of Object.entries(sels)) {
        if (pModel >= ANALYSIS_MIN_PROB && pModel < 0.985 && (!ap || pModel > ap.pModel)) {
          ap = { market: marketCode, selection: sel, pModel: round4(pModel) };
        }
      }
    }
    if (ap && dataQuality >= cfg.minDataQuality) {
      const fair = round2(1 / ap.pModel);
      const best = {
        market: ap.market, selection: ap.selection,
        pModel: ap.pModel, pMarket: null, fairOdds: fair,
        bestPrice: fair, bestBook: 'MODÈLE (cote équitable)', avgPrice: fair,
        overround: null, edge: 0, ev: 0, dispersion: 0, qualifies: false,
        analysisOnly: true,
      };
      return {
        decision: 'ANALYSIS PICK', best, candidates: [],
        noBetReason: null,
        note: 'Aucune cote bookmaker disponible : pronostic issu de l\'analyse seule (marché le plus probable du modèle calibré, cote équitable 1/p — MODEL ESTIMATE).',
      };
    }
    return { decision: 'NO QUALIFIED PICK', best: null, candidates, noBetReason: 'Aucun marché coté disponible et aucun marché du modèle n\'atteint le seuil d\'analyse (p ≥ 58 %).' };
  }
  if (!qualified.length) {
    // MARCHÉS COTÉS MAIS SANS VALUE (§v3.3) : on publie quand même le
    // PRONOSTIC D'ANALYSE (marché le plus probable, p ≥ 0,58) avec la vraie
    // cote bookmaker et l'edge réel affiché — jamais présenté comme VALUE BET.
    const byProb = [...candidates].filter((c) => c.pModel >= 0.58 && c.pModel < 0.985)
      .sort((a, b) => b.pModel - a.pModel);
    if (byProb.length && dataQuality >= cfg.minDataQuality) {
      const best = { ...byProb[0], analysisOnly: true };
      return {
        decision: 'ANALYSIS PICK', best, candidates,
        noBetReason: null,
        note: `Pas de value détectée (edge ${(best.edge * 100).toFixed(1)}%) : pronostic d'analyse fondé sur la probabilité modèle la plus élevée (${(best.pModel * 100).toFixed(0)}%).`,
      };
    }
    const bestNear = candidates[0];
    return {
      decision: 'NO QUALIFIED PICK', best: null, candidates,
      noBetReason: dataQuality < cfg.minDataQuality
        ? `Qualité de données insuffisante (${dataQuality} < ${cfg.minDataQuality}).`
        : `Aucune sélection n'atteint les seuils (edge ≥ ${cfg.minEdge * 100}% et EV ≥ ${cfg.minEV * 100}%). Meilleur candidat : ${bestNear.market}/${bestNear.selection} avec edge ${(bestNear.edge * 100).toFixed(1)}% et EV ${(bestNear.ev * 100).toFixed(1)}%.`,
    };
  }
  const best = qualified[0];
  const decision = best.ev >= cfg.minEV && best.edge >= cfg.minEdge ? 'VALUE BET' : 'PICK';
  return { decision, best, candidates, noBetReason: null };
}

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
