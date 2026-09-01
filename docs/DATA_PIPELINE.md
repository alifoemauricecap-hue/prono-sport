# DATA PIPELINE — PRONO SPORT

## Chaîne (§99)

```
REAL DATA → SOURCE VALIDATION → DATA FUSION → DATA QUALITY → FEATURES
→ MODÈLES STATISTIQUES → ML/ENSEMBLE → CALIBRATION → ANALYSE MARCHÉ
→ PROBABILITÉ → VALUE → RISQUE → DÉCISION
```

## Workers (§14) — tous idempotents, réessayables, journalisés dans `sync_jobs`

| Worker | Intervalle | Priorité §10 | Rôle |
|---|---|---|---|
| `syncLiveMatches` | 60 s | P1 | OpenLigaDB journée courante, événements, transitions de statut |
| `syncFixtures` | 10 min | P2/P3 | fixtures.csv (cotes réelles) + TheSportsDB (validation croisée) |
| `syncResults` | 15 min | P4 | résultats récents, settlement des pronostics |
| `generatePredictions` | 30 min | P5 | analyses des matchs à venir |
| `syncHistoricalData` | 24 h | P7 | CSV de saisons + OpenLigaDB historique |
| `discoverSources` | 6 h | P8 | santé/disponibilité de chaque source du catalogue |

## Fusion multi-sources (§6, §7)

`upsertFixture` rapproche un match (compétition + équipes normalisées + date ±1 j) :
- nouvelle source concordante → `source_ids` enrichi, score identique ⇒ `VERIFIED`
- scores divergents ⇒ `DATA CONFLICT` : valeurs originales conservées dans
  `data_conflicts`, règle de résolution documentée (source à la fiabilité observée
  la plus élevée), conflit exposé dans l'UI — **jamais d'écrasement arbitraire**

## Fraîcheur (§11)

Chaque donnée exposée porte `FRESH` / `STALE` / `UNKNOWN` selon des seuils par
catégorie (live 3 min, fixtures 6 h, cotes 12 h, résultats 24 h). Une donnée
ancienne n'est jamais présentée comme temps réel.

## Cache (§65)

- cache mémoire TTL par URL (45 s à 14 j selon la volatilité)
- `If-None-Match` / `If-Modified-Since` persistés (`http_cache`) → réponses 304 sans re-téléchargement
- hash SHA-256 du contenu pour détecter les mises à jour réelles

## Failover (§64, §97)

Échec d'une source ⇒ compteur d'échec + statut `DEGRADED/DOWN` + notification
`SOURCE_DOWN` ; les autres sources continuent. Si aucune source ne couvre une
donnée ⇒ `DATA UNAVAILABLE`. Jamais de données fictives de repli.
