// PRONO SPORT — xG PROXY ENGINE (MODEL ESTIMATE / CALCULATED DATA)
//
// HONNÊTETÉ : aucune source gratuite validée ne fournit le xG événementiel des
// matchs courants (positions de tirs). PRONO SPORT ne l'invente pas.
// À la place : un PROXY de buts attendus est AJUSTÉ PAR RÉGRESSION sur les
// données réelles de la base (33 000+ lignes tirs/tirs cadrés/buts réels) :
//
//   xG_proxy = a × (tirs cadrés) + b × (tirs non cadrés)
//
// a et b sont estimés par moindres carrés sur l'historique réel — jamais fixés
// arbitrairement. Toujours affiché comme « xG estimé (proxy tirs) », distinct
// d'un vrai xG événementiel (coverage : PARTIAL, pas AVAILABLE).
import { db, now } from '../db.js';

/** Ajuste (a, b) par moindres carrés sur les matchs réels terminés. */
export function fitXgCoefficients() {
  const rows = db.prepare(`SELECT ts.team_side, ts.shots, ts.shots_on_target,
      f.home_score, f.away_score
      FROM team_statistics ts JOIN fixtures f ON f.id=ts.fixture_id
      WHERE f.status='FINISHED' AND ts.shots IS NOT NULL AND ts.shots_on_target IS NOT NULL
        AND f.home_score IS NOT NULL`).all();
  if (rows.length < 500) return null; // INSUFFICIENT DATA : pas d'ajustement bancal
  // Système normal 2×2 (sans intercept) : g ≈ a·sot + b·(shots−sot)
  let Sxx = 0, Sxy = 0, Syy = 0, Sxg = 0, Syg = 0, n = 0;
  for (const r of rows) {
    const goals = r.team_side === 'home' ? r.home_score : r.away_score;
    const sot = r.shots_on_target;
    const off = Math.max(0, r.shots - r.shots_on_target);
    Sxx += sot * sot; Syy += off * off; Sxy += sot * off;
    Sxg += goals * sot; Syg += goals * off; n++;
  }
  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-9) return null;
  const a = (Sxg * Syy - Syg * Sxy) / det;
  const b = (Syg * Sxx - Sxg * Sxy) / det;
  const coeffs = { a: Math.max(0, a), b: Math.max(0, b), n, fitted_at: now() };
  db.prepare(`INSERT INTO kv (key, value) VALUES ('xg_coeffs', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(coeffs));
  return coeffs;
}

export function getXgCoefficients() {
  const row = db.prepare(`SELECT value FROM kv WHERE key='xg_coeffs'`).get();
  if (row) {
    const c = JSON.parse(row.value);
    // ré-ajustement hebdomadaire sur les données accumulées
    if (Date.now() - new Date(c.fitted_at).getTime() < 7 * 24 * 3600_000) return c;
  }
  return fitXgCoefficients();
}

/**
 * xG-proxy moyen pour/contre d'une équipe sur ses derniers matchs AVEC stats réelles.
 * Retourne null si les données manquent (DATA UNAVAILABLE, rien d'inventé).
 */
export function teamXgProxy(teamId, beforeIso, limit = 10) {
  const c = getXgCoefficients();
  if (!c) return null;
  const rows = db.prepare(`SELECT f.id, f.home_team_id, f.away_team_id,
      hs.shots AS h_shots, hs.shots_on_target AS h_sot,
      as2.shots AS a_shots, as2.shots_on_target AS a_sot
      FROM fixtures f
      JOIN team_statistics hs ON hs.fixture_id=f.id AND hs.team_side='home'
      JOIN team_statistics as2 ON as2.fixture_id=f.id AND as2.team_side='away'
      WHERE (f.home_team_id=? OR f.away_team_id=?) AND f.status='FINISHED'
        AND f.kickoff_utc < ? AND hs.shots IS NOT NULL AND as2.shots IS NOT NULL
      ORDER BY f.kickoff_utc DESC LIMIT ?`).all(teamId, teamId, beforeIso, limit);
  if (rows.length < 3) return null;
  const xg = (shots, sot) => c.a * sot + c.b * Math.max(0, shots - sot);
  let xgFor = 0, xgAgainst = 0;
  for (const r of rows) {
    const isHome = r.home_team_id === teamId;
    xgFor += isHome ? xg(r.h_shots, r.h_sot) : xg(r.a_shots, r.a_sot);
    xgAgainst += isHome ? xg(r.a_shots, r.a_sot) : xg(r.h_shots, r.h_sot);
  }
  return {
    xgForAvg: Math.round((xgFor / rows.length) * 100) / 100,
    xgAgainstAvg: Math.round((xgAgainst / rows.length) * 100) / 100,
    matches: rows.length,
    method: `proxy régression sur tirs réels (a=${c.a.toFixed(3)}·cadrés + b=${c.b.toFixed(3)}·non-cadrés, ajusté sur ${c.n} observations réelles)`,
  };
}
