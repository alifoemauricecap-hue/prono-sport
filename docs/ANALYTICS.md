# ANALYTICS & ML — PRONO SPORT

(Ce document couvre ANALYTICS.md et ML.md — moteurs statistiques §30-§36.)

## Modèles

### Elo (`src/engine/elo.js`)
- Rating initial 1500, K=20 modulé par la marge de victoire (méthode World Football Elo)
- Avantage domicile ~60 pts ; taux de nul **calibré sur la fréquence observée** dans
  les données d'entraînement (pas de constante inventée)
- Entraînement strictement chronologique

### Poisson (`src/engine/poisson.js`)
- Forces attaque/défense relatives par équipe, pondération temporelle exponentielle
  (demi-vie 240 j) — les matchs récents pèsent plus (§19)
- λ domicile/extérieur dérivés des moyennes de buts réellement observées par championnat
- Matrice de scores 11×11 → marchés 1X2, O/U 2.5, BTTS, double chance

### Dixon-Coles
- Correction τ de la dépendance des petits scores (0-0, 1-0, 0-1, 1-1)
- ρ estimé par **maximum de vraisemblance** (grid search) sur les données
  d'entraînement — jamais une valeur arbitraire

### Ensemble (§31)
- Poids choisis par **grid search minimisant le log-loss hors-échantillon** du
  backtest walk-forward — validés historiquement par compétition, stockés dans
  `model_versions`. Exemple mesuré (Premier League, 1160 matchs) : l'ensemble
  (LogLoss 1.0228) bat Elo (1.0398), Poisson (1.0249) et Dixon-Coles (1.0230).

## Anti-fuite temporelle (§34)

- `fitStrengths` exclut tout match postérieur à l'instant de référence (testé unitairement)
- Backtest **walk-forward** : chaque prédiction n'utilise que les matchs antérieurs,
  refit périodique
- Features timestampées (`retrieved_at` / `computed_at` partout)

## Calibration (§35) & Backtest Lab (§36)

Endpoint `GET /api/backtest/:competition` et onglet **Backtest Lab** :
- Brier Score et Log Loss par modèle et pour l'ensemble
- Courbe de calibration en 10 tranches : probabilité moyenne prédite vs fréquence observée
- Séparation stricte BACKTEST / PAPER TRACKING / LIVE TRACK RECORD (§55)

## Features (§33)

Dérivées des données réelles disponibles : forme (6 derniers), buts pour/contre,
tirs/cadrés/corners/fautes/cartons moyens, domicile/extérieur, force d'opposition
(via forces relatives), jours de repos, profil arbitre, marché (cotes).
xG / absences / compositions : `DATA UNAVAILABLE` en sources gratuites — les
features correspondantes n'existent pas plutôt que d'être simulées.

## Indicateurs séparés (§48)

- **DATA QUALITY** : fraîcheur + profondeur d'historique + nb de sources + nb de bookmakers + cohérence
- **MODEL CONFIDENCE** : skill du backtest (vs log-loss uniforme ln 3) + profondeur d'échantillon
- **VALUE QUALITY** : edge/EV/dispersion des cotes — jamais confondus.

## xG estimé — proxy régression (MODEL ESTIMATE)

Aucune source gratuite validée ne fournit le xG événementiel des matchs
courants ; PRONO SPORT ne l'invente pas et ne scrape pas de sites non conformes.
À la place, `src/engine/xg.js` ajuste un **proxy** par moindres carrés (2×2 sans
intercept) sur les **tirs réels** de la base :

```
xG_proxy = a × (tirs cadrés) + b × (tirs non cadrés)
```

- Coefficients ajustés sur ≥500 observations réelles (actuellement ~33 880
  lignes `team_statistics`), stockés dans `kv('xg_coeffs')`, ré-ajustés chaque
  semaine. En dessous de 500 observations : **aucun ajustement** (null).
- Ajustement réel actuel : `a ≈ 0.33` par tir cadré, `b` borné à 0 (les tirs
  non cadrés n'apportent pas de pouvoir prédictif marginal significatif sur
  ces données) — rien n'est fixé arbitrairement.
- `teamXgProxy(teamId)` : moyennes xG pour/contre sur les 10 derniers matchs
  **avec stats de tirs réelles** ; moins de 3 matchs → `DATA UNAVAILABLE`.
- Affichage : toujours « xG estimé (proxy tirs) », tag **MODEL ESTIMATE**,
  coverage **PARTIAL** (jamais AVAILABLE) — jamais présenté comme un vrai xG.

## Contexte & classements (CALCULATED DATA)

`src/engine/context.js` recalcule les classements (3/1/0, départage diff puis
buts marqués) **depuis les résultats réels en base** (saison courante = dernier
`season_code` observé). Le dossier complet d'équipe
(`GET /api/teams/:id/profile`) assemble : position au classement, forme
domicile/extérieur, statistiques moyennes réelles, xG-proxy, forces du modèle
(Elo, attaque/défense), fatigue/calendrier — et affiche honnêtement
`DATA UNAVAILABLE` pour les blessures/effectifs (aucune source gratuite
conforme). Endpoint classement : `GET /api/competitions/:code/standings`.
