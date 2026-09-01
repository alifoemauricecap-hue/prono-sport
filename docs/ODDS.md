# ODDS & VALUE BETS — PRONO SPORT

(Couvre ODDS.md et VALUE_BETS.md — §37-§44.)

## Odds Engine (§37)

Cotes **réelles** publiées par Football-Data.co.uk :
- bookmakers nommés : Bet365, Betfair, Betfair Exchange, Pinnacle, William Hill,
  Betway, BetVictor, Paddy Power, Skybet, 1xBet…
- agrégats publiés par la source : moyenne du marché (`Avg`) et maximum (`Max`)
- marchés : 1X2 et Over/Under 2.5 (les seuls réellement distribués par la source —
  aucun autre marché n'est affiché, §42)

Chaque cote : bookmaker, marché, sélection, valeur, source, timestamp, statut.

## Historique des cotes (§38)

`odds_snapshots` enregistre un point **à chaque changement réel de valeur**
détecté entre deux publications de la source. L'onglet Cotes affiche l'évolution
(sparklines) ; si un seul snapshot existe, l'UI le dit — aucun mouvement simulé.

## Multi-bookmaker (§39)

Par sélection : meilleure cote (+ bookmaker), moyenne, dispersion (max−min).

## Value Bet Engine (§40) — formules documentées

```
implied_raw(s)   = 1 / cote(s)
overround        = Σ implied_raw          (marge du bookmaker)
P_marché(s)      = implied_raw(s) / overround   (probabilité sans marge)
fair_odds        = 1 / P_modèle
edge             = P_modèle − P_marché
EV               = P_modèle × meilleure_cote − 1
```

## Critères de qualification (configurés dans `src/config.js`)

| Critère | Seuil | Raison |
|---|---|---|
| edge | ≥ 3 % | dépasse l'incertitude typique de calibration |
| EV | ≥ 2 % | espérance positive nette après dispersion |
| P_modèle | ≥ 5 % | exclut les très longues cotes mal calibrées |
| Data Quality | ≥ 0.55 | données fraîches + historique suffisant |
| Historique/équipe | ≥ 8 matchs | profondeur minimale d'estimation |

## Aucun pronostic par défaut (§41, §44)

**Tous** les marchés cotés sont analysés (tableau complet dans l'onglet
Pronostics). Si aucune sélection ne passe les seuils : `# NO QUALIFIED PICK`
avec la raison exacte (meilleur candidat et ses métriques). Aucun marché
(Over 1.5, BTTS, 1X2…) n'est jamais choisi d'office.

## Suivi (§54-§56)

Chaque pick enregistré est **immuable** : fixture, timestamp, version modèle et
features, marché, sélection, probabilités, cote, fair odds, edge, EV, confiance,
data quality, décision. Settlement automatique WIN/LOSS/VOID à la fin du match ;
les recalculs ultérieurs vont dans `prediction_snapshots`, l'original ne change
jamais. Track record = **paper tracking réel**, jamais de taux fictif.
