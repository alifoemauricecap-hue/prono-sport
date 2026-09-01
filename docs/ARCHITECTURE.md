# ARCHITECTURE — PRONO SPORT

## Vue d'ensemble

```
FRONTEND (SPA vanilla, mobile-first, SSE)
   ↓
API (Express — REST + Server-Sent Events, rate limiting, en-têtes durcis)
   ↓
DATA AGGREGATION (adapters providers, §68)
   ↓
DATA VALIDATION & FUSION (multi-sources, conflits, VERIFIED)
   ↓
DATABASE (SQLite WAL — 30+ tables, provenance intégrale)
   ↓
CACHE (mémoire + ETag/Last-Modified/Content-Hash persistés)
   ↓
LIVE ENGINE (workers 60 s, transitions de statut confirmées par source)
   ↓
ANALYTICS ENGINE (forme, H2H, fatigue, arbitre, stats)
   ↓
PREDICTION ENGINE (Elo + Poisson + Dixon-Coles + ensemble validé)
   ↓
ODDS ENGINE (cotes réelles multi-bookmakers, snapshots d'évolution)
   ↓
VALUE ENGINE (edge, EV, fair odds, NO QUALIFIED PICK)
   ↓
AI EXPLANATION (rapports & assistant ancrés dans les données)
```

## Modules

| Chemin | Rôle |
|---|---|
| `src/config.js` | configuration, seuils documentés, tags de données |
| `src/db.js` | schéma SQLite, journalisation des jobs, notifications |
| `src/util/http.js` | client HTTP : cache intelligent, fiabilité observée des sources |
| `src/util/csv.js`, `src/util/teamNames.js` | parsing CSV, déduplication d'équipes |
| `src/providers/registry.js` | Source Discovery Engine : catalogue, santé, conditions |
| `src/providers/repository.js` | Data Fusion Engine : upserts, provenance, conflits |
| `src/providers/*.js` | adapters : Football-Data.co.uk, TheSportsDB, OpenLigaDB, Open-Meteo |
| `src/engine/elo.js`, `poisson.js` | modèles statistiques |
| `src/engine/models.js` | ensemble + Backtest Lab (walk-forward, calibration) |
| `src/engine/value.js` | Value Bet Engine + Data Quality + Model Confidence |
| `src/engine/predictions.js` | orchestrateur, audit trail, settlement |
| `src/engine/reports.js` | Expert Match Report + assistant IA |
| `src/workers/scheduler.js` | workers idempotents, priorités, failover, SSE |
| `src/api/routes.js` | API REST + stream temps réel |
| `public/` | SPA (aucune dépendance frontend) |
| `test/` | tests d'intégrité, moteurs, providers |

## Abstraction des providers (§68)

Aucune dépendance à une source unique. Interfaces implicites :
- **FootballDataProvider** : `syncLeagueUpcoming/Past` (TheSportsDB), `syncCurrentMatchday/Season` (OpenLigaDB), `syncUpcomingFixtures` (Football-Data.co.uk)
- **HistoricalDataProvider** : `syncHistoricalSeason`
- **OddsProvider** : ingestion 1X2 + O/U 2.5 multi-bookmakers
- **WeatherProvider** : `geocode` + `fetchMatchWeather`

Ajouter une source = ajouter un adapter + une entrée au catalogue du registre. Le failover est automatique : si une source échoue, les autres continuent, la panne est journalisée et comptée dans la fiabilité.

## Choix techniques

- **Node.js 20+ / Express** : un seul runtime, déployable partout (contrainte §90).
- **SQLite (better-sqlite3, WAL)** : zéro dépendance externe, transactions rapides ; migration PostgreSQL prévue (le repository isole tout le SQL).
- **SSE plutôt que WebSocket** : unidirectionnel serveur→client suffisant, compatible proxys.
- **SPA sans framework** : bundle nul, chargement instantané, aucune chaîne de build à maintenir.

## Environnements (§70)

`NODE_ENV` : development / staging / production. Les bases de test sont créées avec des chemins isolés et détruites après les tests — jamais de contamination de la production.

## Scalabilité

Étapes prévues : PostgreSQL managé → Redis pour le cache HTTP → workers extraits en processus séparés → files (BullMQ) → répliques de lecture. Le découpage actuel (providers/engine/workers/api) rend chaque étape incrémentale.
