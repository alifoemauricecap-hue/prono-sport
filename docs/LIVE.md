# LIVE — PRONO SPORT

## Principe d'honnêteté

Le statut `LIVE` n'est affiché **que lorsqu'une source du registre le confirme**.
Couverture actuelle : OpenLigaDB (Bundesliga 1/2) — scores et buteurs quasi temps réel.

Pour les autres compétitions : quand l'heure du coup d'envoi est passée sans
confirmation de source, le match passe en `UNKNOWN` (« À confirmer ») — il n'est
**jamais** présenté comme live (§12), et aucun événement n'est inventé (§16).

## Machine à états (§13)

```
SCHEDULED → UPCOMING (fenêtre -2 h, transition horloge, CALCULATED)
UPCOMING  → LIVE      (uniquement sur confirmation source)
LIVE      → HALFTIME / EXTRA_TIME / PENALTIES (selon source)
LIVE      → FINISHED  (résultat final de la source)
*         → POSTPONED / CANCELLED / SUSPENDED / ABANDONED / UNKNOWN
```

## Cycle live (§15)

1. `syncLiveMatches` (60 s) interroge la journée courante OpenLigaDB
2. détection kickoff passé + `matchIsFinished=false` ⇒ LIVE
3. ingestion des buts réels (`fixture_events` : minute, buteur, penalty/csc, score courant)
4. mise à jour du score courant à partir du dernier but
5. diffusion SSE `live_update` → l'interface se rafraîchit sans rechargement

## Fin de match (§17)

`FINISHED` ⇒ score final + statistiques finales (quand publiées par
Football-Data.co.uk) + settlement automatique des pronostics
(WIN / LOSS / VOID — le pronostic original n'est jamais modifié, §54)
⇒ événement SSE `predictions_settled`.

## Recalcul live (§53)

Les probabilités ne sont recalculées en cours de match que si les données
nécessaires sont disponibles ; les sources gratuites actuelles ne fournissant pas
de flux minute-par-minute suffisant hors Bundesliga, aucun recalcul artificiel
n'est effectué (conforme §53 : « ne pas recalculer artificiellement »).

## Live Prediction Engine (§53) — recalcul minute par minute

Pour les matchs **confirmés LIVE par une source du registre** (OpenLigaDB, D1/D2
allemandes), le moteur `src/engine/live.js` recalcule les probabilités du
résultat final toutes les 60 secondes et à chaque changement de score :

- **Données réelles** : score courant (SOURCE DATA) + minute estimée depuis le
  coup d'envoi (CALCULATED — horloge, mi-temps ~15 min déduite au-delà de 60
  minutes d'horloge ; jamais présentée comme la minute officielle).
- **Méthode (MODEL ESTIMATE)** : λ pré-match du modèle d'ensemble ×
  fraction de temps restante (base 95 minutes effectives, arrêts de jeu inclus),
  matrice de Poisson sur les buts restants ajoutée au score acquis.
- **Snapshots immuables** : chaque recalcul est inséré dans `live_predictions`
  (minute, score, probabilités, déclencheur `SCORE_CHANGE`/`TIME`, horodatage)
  et n'est **jamais réécrit** — l'UI affiche l'historique AVANT → APRÈS complet.
- **Diffusion** : événement SSE `live_prediction` ; onglet **Live** du Match
  Center ; endpoint `GET /api/fixtures/:id/live`.
- **Honnêteté** : pas de modèle entraînable ou match non confirmé live →
  aucun recalcul artificiel, statut affiché tel quel.

Tests : `test/live.test.js` (certitude en fin de match, symétrie home/away,
effet d'un but, bornes de la minute estimée).
