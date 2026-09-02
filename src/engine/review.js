// PRONO SPORT — POST-MATCH REVIEW ENGINE (suivi des pronostics après coup)
// « Ne jamais donner un pronostic puis l'oublier » : chaque match terminé qui
// portait un pronostic reçoit un COMPTE RENDU individuel expliquant pourquoi
// le pronostic a été validé ou non, à partir de FAITS OBSERVÉS uniquement :
//   - score final / mi-temps (SOURCE DATA)
//   - faits de jeu : buts, cartons, remplacements — via recherche ciblée ESPN
//     (résumé officiel du match) et OpenLigaDB quand disponibles
//   - statistiques d'équipe (tirs, corners, cartons) si la source les publie
//   - météo enregistrée avant match
// Ce qui n'est pas observable est dit ABSENT — jamais romancé.
import { db, now, notify } from '../db.js';
import { evaluateSelection } from './predictions.js';
import { fetchEventSummary } from '../providers/espn.js';

/** Construit (une seule fois) le compte rendu d'un match terminé. */
export async function buildReview(fixtureId) {
  const existing = db.prepare(`SELECT fixture_id FROM prediction_reviews WHERE fixture_id=?`).get(fixtureId);
  if (existing) return { status: 'EXISTS' };
  const f = db.prepare(`SELECT f.*, c.code AS comp_code, c.name AS comp_name,
      ht.name AS home_name, at2.name AS away_name
      FROM fixtures f JOIN competitions c ON c.id=f.competition_id
      JOIN teams ht ON ht.id=f.home_team_id JOIN teams at2 ON at2.id=f.away_team_id
      WHERE f.id=?`).get(fixtureId);
  if (!f || f.status !== 'FINISHED' || f.home_score == null) return { status: 'NOT_FINISHED' };

  const preds = db.prepare(`SELECT * FROM predictions WHERE fixture_id=? AND decision IN ('PICK','VALUE BET','ANALYSIS PICK')`).all(fixtureId);
  const factors = [];
  const sources = new Set();

  // 1) Faits de base — score (SOURCE DATA)
  factors.push({
    type: 'score', tag: 'SOURCE DATA',
    detail: `Score final ${f.home_score}-${f.away_score}${f.ht_home != null ? ` (mi-temps ${f.ht_home}-${f.ht_away})` : ''}.`,
    source: JSON.parse(f.source_ids || '[]').join(','),
  });
  for (const s of JSON.parse(f.source_ids || '[]')) sources.add(s);

  // 2) RECHERCHE APPROFONDIE CIBLÉE : résumé officiel ESPN (buts, cartons, etc.)
  const ext = JSON.parse(f.external_ids || '{}');
  if (ext.espn) {
    try {
      const summary = await fetchEventSummary(f.comp_code, ext.espn);
      if (summary?.keyEvents?.length) {
        sources.add('espn');
        for (const ev of summary.keyEvents) {
          factors.push({
            type: ev.kind, tag: 'SOURCE DATA', minute: ev.minute,
            detail: ev.text, source: 'espn',
          });
        }
      }
    } catch { /* résumé indisponible : les faits de base restent */ }
  }

  // 3) Faits de jeu déjà en base (OpenLigaDB : buteurs/minutes)
  for (const ev of db.prepare(`SELECT minute, type, player_name, team_side, detail, source_id
      FROM fixture_events WHERE fixture_id=? ORDER BY minute`).all(fixtureId)) {
    factors.push({
      type: ev.type, tag: 'SOURCE DATA', minute: ev.minute,
      detail: `${ev.minute != null ? ev.minute + "' " : ''}${ev.type}${ev.player_name ? ' — ' + ev.player_name : ''}${ev.detail ? ' (' + ev.detail + ')' : ''}`,
      source: ev.source_id,
    });
    sources.add(ev.source_id);
  }

  // 4) Statistiques d'équipe publiées par la source (tirs, corners, cartons)
  const stats = db.prepare(`SELECT * FROM team_statistics WHERE fixture_id=?`).all(fixtureId);
  for (const s of stats) {
    const bits = [];
    if (s.shots != null) bits.push(`${s.shots} tirs`);
    if (s.shots_on_target != null) bits.push(`${s.shots_on_target} cadrés`);
    if (s.corners != null) bits.push(`${s.corners} corners`);
    if (s.yellow != null) bits.push(`${s.yellow} jaunes`);
    if (s.red) bits.push(`${s.red} ROUGE(S)`);
    if (bits.length) {
      factors.push({
        type: 'stats', tag: 'SOURCE DATA',
        detail: `${s.team_side === 'HOME' ? f.home_name : f.away_name} : ${bits.join(', ')}.`,
        source: s.source_id,
      });
      sources.add(s.source_id);
    }
  }

  // 5) Météo enregistrée avant match
  const w = db.prepare(`SELECT * FROM weather WHERE fixture_id=?`).get(fixtureId);
  if (w?.summary) {
    factors.push({ type: 'weather', tag: 'SOURCE DATA', detail: `Météo au coup d'envoi : ${w.summary}.`, source: 'open-meteo' });
    sources.add('open-meteo');
  }

  // 6) Verdict pronostic par pronostic — évaluation factuelle
  const legs = [];
  for (const p of preds) {
    const won = evaluateSelection(p.market, p.selection, f.home_score, f.away_score);
    legs.push({
      market: p.market, selection: p.selection,
      probability: p.probability, odds: p.odds,
      verdict: won == null ? 'VOID' : won ? 'VALIDATED' : 'NOT_VALIDATED',
    });
  }
  const verdict = !legs.length ? 'NO_PICK'
    : legs.every((l) => l.verdict === 'VALIDATED') ? 'VALIDATED'
    : legs.every((l) => l.verdict === 'NOT_VALIDATED') ? 'NOT_VALIDATED' : 'MIXED';

  // 7) Rédaction factuelle du compte rendu
  const summary = writeSummary(f, legs, factors);
  db.prepare(`INSERT INTO prediction_reviews (fixture_id, created_at, verdict, summary, factors_json, research_sources)
      VALUES (?,?,?,?,?,?)`)
    .run(fixtureId, now(), verdict, summary, JSON.stringify({ legs, factors }), [...sources].join(','));
  notify('REVIEW_READY', { fixtureId, verdict });
  return { status: 'CREATED', verdict };
}

function writeSummary(f, legs, factors) {
  const lines = [];
  lines.push(`${f.home_name} ${f.home_score}-${f.away_score} ${f.away_name} (${f.comp_name}).`);
  for (const l of legs) {
    const pct = l.probability != null ? ` (probabilité annoncée ${(l.probability * 100).toFixed(0)}%)` : '';
    if (l.verdict === 'VALIDATED') {
      lines.push(`✅ Pronostic ${l.market}/${l.selection}${pct} VALIDÉ par le score réel.`);
    } else if (l.verdict === 'NOT_VALIDATED') {
      lines.push(`❌ Pronostic ${l.market}/${l.selection}${pct} NON VALIDÉ.`);
    } else {
      lines.push(`⚪ Pronostic ${l.market}/${l.selection} annulé (match non standard).`);
    }
  }
  // faits marquants observés susceptibles d'expliquer l'issue
  const reds = factors.filter((x) => /red|rouge/i.test(x.type) || /ROUGE/.test(x.detail || ''));
  const goals = factors.filter((x) => /goal|but/i.test(x.type));
  const explain = [];
  if (reds.length) explain.push(`carton(s) rouge(s) observé(s) : ${reds.map((r) => r.detail).join(' · ')}`);
  if (goals.length) explain.push(`${goals.length} fait(s) de but documenté(s) minute par minute`);
  if (explain.length) lines.push(`Faits de jeu observés : ${explain.join(' ; ')}.`);
  const obs = factors.filter((x) => x.type === 'stats');
  if (obs.length) lines.push(`Statistiques publiées par la source : ${obs.map((o) => o.detail).join(' ')}`);
  if (!reds.length && !goals.length && !obs.length) {
    lines.push(`Aucun fait de jeu détaillé publié par les sources gratuites pour ce match — le verdict repose sur le score officiel uniquement (jamais de facteur inventé).`);
  }
  return lines.join('\n');
}

/** Worker : comptes rendus des matchs terminés récents portant un pronostic. */
export async function generatePendingReviews(limit = 8) {
  const rows = db.prepare(`SELECT DISTINCT f.id FROM fixtures f
      JOIN predictions p ON p.fixture_id=f.id AND p.decision IN ('PICK','VALUE BET','ANALYSIS PICK')
      LEFT JOIN prediction_reviews r ON r.fixture_id=f.id
      WHERE f.status='FINISHED' AND f.home_score IS NOT NULL AND r.fixture_id IS NULL
        AND f.kickoff_utc > datetime('now', '-72 hours')
      ORDER BY f.kickoff_utc DESC LIMIT ?`).all(limit);
  let created = 0;
  for (const r of rows) {
    try {
      const res = await buildReview(r.id);
      if (res.status === 'CREATED') created++;
    } catch { /* réessayé au prochain cycle */ }
    await new Promise((rs) => setTimeout(rs, 400)); // politesse + event loop
  }
  return created;
}
