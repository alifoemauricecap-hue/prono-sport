# PRONO SPORT — Référence API (REST + SSE)

Toutes les réponses sont en JSON : `{ data: …, note?: … }`. Une route inconnue
sous `/api` renvoie `404 { error: 'NOT_FOUND' }`. Aucune donnée inventée :
chaque champ est étiqueté à la source (`SOURCE DATA` / `CALCULATED DATA` /
`MODEL ESTIMATE`) et les absences sont explicites (`DATA UNAVAILABLE`,
`INSUFFICIENT DATA`, `NO QUALIFIED PICK`).

## Santé & temps réel

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | État du service (uptime, base, sources) |
| GET | `/api/stream` | **SSE** : `hello`, `live_update`, `live_prediction`, `predictions_settled` |

## Matchs

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/fixtures/live` | Matchs confirmés LIVE par une source (jamais supposés) |
| GET | `/api/fixtures/upcoming` | Matchs à venir (filtres `?comp=`, `?days=`) |
| GET | `/api/fixtures/finished` | Derniers résultats réels |
| GET | `/api/fixtures/:id` | Fiche complète : score, statut, validation, provenance, événements, stats, conflits |
| GET | `/api/fixtures/:id/analysis` | Rapport expert : forme, H2H, stats, **contexte classement**, **xG-proxy**, arbitre, modèles, décision value |
| GET | `/api/fixtures/:id/live` | **Suivi live** : probabilités pré-match + snapshots immuables minute par minute (AVANT → APRÈS) |
| GET | `/api/fixtures/:id/odds` | Cotes réelles par marché/bookmaker + historique de snapshots |
| GET | `/api/fixtures/:id/weather` | Météo au coup d'envoi (Open-Meteo) ou `WEATHER DATA UNAVAILABLE` |

## Équipes & compétitions

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/teams/:id` | Fiche équipe : prochains matchs, derniers résultats |
| GET | `/api/teams/:id/profile` | **Dossier complet** : contexte/classement, forme dom/ext, stats moyennes, xG-proxy, Elo + forces (interne), fatigue/calendrier (externe), effectif (`DATA UNAVAILABLE` honnête) |
| GET | `/api/competitions` | Compétitions couvertes + profondeur historique mesurée |
| GET | `/api/competitions/:code/standings` | **Classement calculé** depuis les résultats réels (3/1/0) |
| GET | `/api/coverage` | Coverage Center : matrice mesurée par compétition (xG = PARTIAL → proxy) |
| GET | `/api/backtest/:code` | Backtest walk-forward par compétition (LogLoss/Brier, poids d'ensemble) |

## Value bets & pronostics

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/value-bets` | Value bets **pré-match uniquement** (edge, EV, fair odds, bookmaker réel) |
| GET | `/api/predictions` | Audit trail immuable : pronostics + settlement WIN/LOSS/VOID/PENDING |

## Sources & administration

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/sources` | Source Monitor : santé, fiabilité mesurée, fraîcheur |
| GET | `/api/discovery` | Discovery Engine : candidats PENDING/APPROVED/REJECTED (auditables) |
| GET | `/api/search?q=` | Recherche équipes / matchs / compétitions |
| GET | `/api/admin/overview` | Compteurs, jobs de synchro, conflits |
| POST | `/api/assistant` | Assistant ancré sur les données réelles de la base |
| GET/POST/DELETE | `/api/favorites` | Favoris utilisateur |

## Garanties transverses

- **§34** : aucun pronostic n'est enregistré après le coup d'envoi (garde `isPreMatch` + test de régression).
- **§53** : recalcul live uniquement pour les matchs confirmés live ; snapshots jamais réécrits.
- **§54** : pronostics immuables ; toute mise à jour devient un snapshot horodaté.
- Erreurs : `400` (paramètre invalide), `404` (introuvable) — jamais de 200 avec données fabriquées.
