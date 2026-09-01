// PRONO SPORT — SOURCE DISCOVERY & REGISTRY ENGINE (§3, §4, §5, §8)
// Registre des sources gratuites réellement testées. Chaque source passe par :
// DISCOVERED → TEST → VALIDATE → CLASSIFY → QUALITY CHECK → APPROVE / REJECT
// Le reliability_score est UNIQUEMENT calculé à partir des fetchs observés (util/http.js).
import { db, now, logJob } from '../db.js';

// Catalogue des sources candidates. terms_status reflète les conditions publiées
// par chaque source ; une source dont les conditions interdisent l'accès
// automatisé serait marquée SOURCE_NOT_ALLOWED et jamais utilisée (§5).
export const SOURCE_CATALOG = [
  {
    source_id: 'football-data-couk',
    source_name: 'Football-Data.co.uk',
    source_url: 'https://www.football-data.co.uk',
    source_type: 'CSV public',
    data_categories: 'results,statistics,odds,historical,fixtures,referees',
    coverage: '22+ divisions européennes, historique depuis 1993',
    update_frequency: '1-2x/jour',
    terms_status: 'Données CSV publiques distribuées gratuitement pour analyse ; attribution recommandée',
    attribution_required: 1,
    attribution_text: 'Données historiques et cotes : Football-Data.co.uk',
    requires_key: 0,
    test_url: 'https://www.football-data.co.uk/fixtures.csv',
    notes: 'Cotes réelles (Bet365, Betfair, Pinnacle…) + stats complètes (tirs, corners, cartons, arbitre).',
  },
  {
    source_id: 'thesportsdb',
    source_name: 'TheSportsDB',
    source_url: 'https://www.thesportsdb.com',
    source_type: 'API JSON gratuite',
    data_categories: 'fixtures,results,teams,badges,venues,leagues,players',
    coverage: 'Mondiale (couverture variable selon ligue)',
    update_frequency: 'continue',
    terms_status: 'API gratuite avec clé de test publique documentée ; limites de débit sur le tier gratuit',
    attribution_required: 1,
    attribution_text: 'Métadonnées équipes/matchs : TheSportsDB.com',
    requires_key: 0,
    test_url: 'https://www.thesportsdb.com/api/v1/json/123/all_leagues.php',
    notes: 'Logos équipes, stades, calendriers. Livescores réservés au tier premium (non utilisé).',
  },
  {
    source_id: 'openligadb',
    source_name: 'OpenLigaDB',
    source_url: 'https://api.openligadb.de',
    source_type: 'API JSON open data',
    data_categories: 'fixtures,results,live,events,goals,tables',
    coverage: 'Allemagne (Bundesliga 1/2, DFB-Pokal…)',
    update_frequency: 'quasi temps réel pendant les matchs',
    terms_status: 'Open data communautaire, accès libre documenté',
    attribution_required: 1,
    attribution_text: 'Données Bundesliga : OpenLigaDB',
    requires_key: 0,
    test_url: 'https://api.openligadb.de/getavailableleagues',
    notes: 'Buteurs et scores minute par minute pour les ligues allemandes.',
  },
  {
    source_id: 'open-meteo',
    source_name: 'Open-Meteo',
    source_url: 'https://open-meteo.com',
    source_type: 'API météo gratuite',
    data_categories: 'weather',
    coverage: 'Mondiale',
    update_frequency: 'horaire',
    terms_status: 'Gratuit pour usage non commercial, sans clé ; attribution demandée',
    attribution_required: 1,
    attribution_text: 'Météo : Open-Meteo.com',
    requires_key: 0,
    test_url: 'https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&hourly=temperature_2m&forecast_days=1',
    notes: 'Prévisions + géocodage gratuit.',
  },
  {
    source_id: 'football-data-org',
    source_name: 'football-data.org',
    source_url: 'https://www.football-data.org',
    source_type: 'API JSON (tier gratuit avec clé)',
    data_categories: 'fixtures,results,standings,teams',
    coverage: '12 compétitions majeures (tier gratuit)',
    update_frequency: 'continue (10 req/min en gratuit)',
    terms_status: 'Tier gratuit officiel, clé API requise',
    attribution_required: 1,
    attribution_text: 'Football data provided by the Football-Data.org API',
    requires_key: 1,
    test_url: null, // testée uniquement si une clé est fournie
    notes: 'Optionnelle : activée si FOOTBALL_DATA_ORG_KEY est défini.',
  },
];

export function registerSources() {
  const stmt = db.prepare(`INSERT INTO data_sources
    (source_id, source_name, source_url, source_type, data_categories, coverage,
     update_frequency, terms_status, attribution_required, attribution_text, requires_key, notes, availability_status)
    VALUES (@source_id, @source_name, @source_url, @source_type, @data_categories, @coverage,
     @update_frequency, @terms_status, @attribution_required, @attribution_text, @requires_key, @notes, 'DISCOVERED')
    ON CONFLICT(source_id) DO UPDATE SET
     source_name=excluded.source_name, terms_status=excluded.terms_status, notes=excluded.notes`);
  for (const s of SOURCE_CATALOG) stmt.run(s);
}

// TEST → VALIDATE → APPROVE / REJECT
export async function checkSourceHealth() {
  const { fetchText } = await import('../util/http.js');
  const job = logJob('discoverSources', null);
  let ok = 0, errors = [];
  for (const s of SOURCE_CATALOG) {
    if (!s.test_url) {
      db.prepare(`UPDATE data_sources SET availability_status='REQUIRES_KEY', last_checked=? WHERE source_id=?`)
        .run(now(), s.source_id);
      continue;
    }
    try {
      await fetchText(s.test_url, { sourceId: s.source_id, ttlMs: 5 * 60_000 });
      db.prepare(`UPDATE data_sources SET availability_status='AVAILABLE' WHERE source_id=?`).run(s.source_id);
      ok++;
    } catch (e) {
      errors.push(`${s.source_id}: ${e.message}`);
      db.prepare(`UPDATE data_sources SET availability_status='DOWN', last_failed_fetch=?, last_checked=? WHERE source_id=?`)
        .run(now(), now(), s.source_id);
    }
  }
  job.finish(errors.length ? (ok ? 'PARTIAL' : 'FAILED') : 'COMPLETED', ok, errors.join('; '));
  return { ok, errors };
}

export function getSources() {
  return db.prepare(`SELECT *,
    CASE WHEN success_count+failure_count>0
      THEN total_latency_ms/(success_count+failure_count) ELSE NULL END AS avg_latency_ms
    FROM data_sources ORDER BY source_id`).all();
}
