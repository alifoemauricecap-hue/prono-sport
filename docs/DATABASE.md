# DATABASE — PRONO SPORT

SQLite (WAL) — fichier `data/pronosport.db`. Toutes les entités portent un
`PRONO_INTERNAL_ID` (colonne `id`) et les IDs externes des sources dans
`external_ids` (JSON, §59). Provenance systématique (§57).

## Tables (§58)

### Référentiel
- `continents`, `countries`, `competitions` (+ `historical_from/to` mesurés), `seasons`, `rounds`
- `venues` (lat/lon géocodés), `teams` (`normalized_name` pour la déduplication §60), `players`, `coaches`, `referees`

### Matchs
- `fixtures` — statut (§13), scores, provenance `source_ids` (JSON), `external_ids`,
  `validation_status` (`UNVERIFIED` | `VERIFIED` ≥2 sources concordantes | `DATA CONFLICT`),
  `data_tag`, `retrieved_at`, `updated_at`
- `fixture_events` — buts/cartons/etc. réels avec minute, source, horodatage
- `lineups`, `team_statistics` (tirs, cadrés, fautes, corners, cartons), `player_statistics`
- `injuries`, `suspensions` (structure prête ; aucune source gratuite validée → vides, jamais remplies artificiellement)
- `weather` — relevé Open-Meteo par match

### Marché
- `bookmakers`, `markets`, `odds` (cote courante par book/marché/sélection)
- `odds_snapshots` — historique d'évolution (§38), un snapshot par changement réel de valeur

### Modèles & décisions
- `model_versions` — version, date, matchs d'entraînement, Brier/LogLoss de backtest, poids d'ensemble
- `model_outputs` — sorties par modèle et par match (transparence §85)
- `predictions` — audit trail complet (§56) : marché, sélection, probabilité, cote, fair odds,
  edge, EV, confiance, data quality, décision, résultat (WIN/LOSS/VOID/PENDING), **immuable** (§54)
- `prediction_snapshots` — recalculs ultérieurs ajoutés en snapshots, l'original n'est jamais modifié
- `value_bets`, `analysis_reports`

### Plateforme
- `data_sources` — registre du Source Discovery Engine (§4) : fiabilité observée,
  disponibilité, conditions d'utilisation, attribution, latence cumulée
- `data_quality` — score par entité avec composantes JSON (§47)
- `data_conflicts` — conflits inter-sources avec valeurs originales et règle de résolution documentée (§6)
- `sync_jobs` — journal des workers, `notifications`, `users`, `favorites`
- `http_cache` — ETag / Last-Modified / hash de contenu (§65)

## Intégrité

- FK activées (`PRAGMA foreign_keys=ON`)
- Contraintes UNIQUE anti-doublons sur fixtures, odds, stats, prédictions
- Upserts idempotents partout (workers réexécutables sans effet de bord)

## Migration PostgreSQL

Le SQL est confiné à `db.js`, `repository.js` et aux requêtes des routes ; le schéma
est standard (types simples, JSON en TEXT). Migration : remplacer better-sqlite3 par
`pg`, transformer `INSERT OR IGNORE`/`ON CONFLICT` (syntaxe déjà compatible) et
déplacer `http_cache` vers Redis.
