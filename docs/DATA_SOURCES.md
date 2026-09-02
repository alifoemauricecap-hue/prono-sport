# DATA SOURCES — PRONO SPORT

## Principe (§3, §5, §8)

Priorité aux sources **gratuites et publiques**, réellement testées avant usage.
Cycle : `DISCOVERED → TEST → VALIDATE → CLASSIFY → QUALITY CHECK → APPROVE/REJECT`.
Une source gratuite n'est jamais présumée fiable : la fiabilité est **calculée**
(`success_count / (success_count + failure_count)`) à partir des fetchs observés.
Une source dont les conditions interdisent l'accès automatisé serait marquée
`SOURCE_NOT_ALLOWED` et jamais utilisée. Aucun contournement de protection technique.

## Sources actives

### 1. Football-Data.co.uk — `football-data-couk`
- **Type** : CSV publics · **Clé** : aucune
- **Données Europe** : résultats depuis 1993, statistiques de match (tirs, tirs cadrés, fautes,
  corners, cartons, arbitre), **cotes réelles 1X2 et O/U 2.5** de bookmakers nommés
  (Bet365, Betfair, Pinnacle, William Hill…) + moyennes/max du marché, fixtures du
  prochain tour avec cotes (`fixtures.csv`)
- **Données MONDE** (`/new/<PAYS>.csv`, vérifiées) : historique complet **depuis ~2012**
  avec cotes réelles (Pinnacle clôture, Bet365, Betfair Exchange, moyenne/max) pour :
  Argentine, Autriche, Brésil, Chine, Danemark, Finlande, Irlande, Japon, Mexique,
  Norvège, Pologne, Roumanie, Russie, Suède, Suisse, USA (MLS) — plus
  `new_league_fixtures.csv` : **fixtures mondiales à venir cotées**
- **Couverture totale** : 32 championnats sur 4 continents
- **Mise à jour** : 1-2×/jour (pas de temps réel)
- **Conditions** : données distribuées gratuitement pour l'analyse ; attribution recommandée (affichée dans le footer)
- **Limites** : pas de live, cotes figées entre deux publications
- **Risques** : changement de format CSV (parseur robuste + jobs journalisés)

### 2. TheSportsDB — `thesportsdb`
- **Type** : API JSON gratuite · **Clé** : clé de test publique `123` documentée par la source ; clé Patreon optionnelle (`THESPORTSDB_KEY`)
- **Données** : calendriers, résultats, logos, stades, métadonnées ligues/équipes — mondial
- **Rôle 1** : source **secondaire de validation croisée** des scores (§6) + enrichissement visuel
- **Rôle 2** : moteur du **SOURCE DISCOVERY ENGINE** — découverte autonome de ligues
  mondiales : graines candidates + scan par pays (`all_countries` → `search_all_leagues`),
  chaque candidate testée individuellement (`lookupleague` : sport strictement Soccer —
  le test a réellement rejeté un ID rugby — puis vérification d'événements disponibles)
  avant APPROVE/REJECT ; les ligues validées sont rattachées aux compétitions CSV
  existantes (fusion ARG1/BRA1/MEX1/USA1…) ou créées dynamiquement (A-League, Saudi Pro League)
- **Limites** : tier gratuit — listes tronquées (~15 événements), rate limit (HTTP 429)
  respecté par throttling 2 s + backoff : jamais de contournement (§5)

### 3. OpenLigaDB — `openligadb`
- **Type** : open data communautaire · **Clé** : aucune
- **Données** : Bundesliga 1/2 — scores, buteurs minute par minute, quasi temps réel
- **Rôle** : **seule source LIVE confirmée** du registre → le statut LIVE n'est affiché que sur sa couverture
- **Limites** : Allemagne uniquement

### 4. Open-Meteo — `open-meteo`
- **Type** : API météo gratuite · **Clé** : aucune
- **Données** : prévisions horaires (température, précipitations, vent, humidité) + géocodage
- **Conditions** : gratuit usage non commercial, attribution demandée (affichée)
- **Limites** : fenêtre de prévision ~14 jours → au-delà `WEATHER DATA UNAVAILABLE`

### 5. football-data.org — `football-data-org` (optionnelle)
- **Clé gratuite requise** (`FOOTBALL_DATA_ORG_KEY`) — non activée par défaut :
  statut `REQUIRES_KEY` dans le Source Monitor. 12 compétitions, 10 req/min en tier gratuit.

## Sources candidates surveillées (Source Monitor)

- **StatsBomb Open Data** (`statsbomb-open`) : xG événementiel réel, open data GitHub,
  gratuit avec attribution — couverture partielle et non temps réel ; testée en continu,
  intégrable comme enrichissement historique.
- **openfootball** (`openfootball`) : domaine public (CC0), calendriers/résultats —
  candidate de **failover** ; sa fraîcheur observée décidera de son usage.
- **ESPN endpoints publics** (`espn-public`) : couverture mondiale temps réel MAIS
  conditions d'usage automatisé non confirmées → **NON UTILISÉE** pour les données
  tant que le statut n'est pas clarifié (§5 : le respect des sources prime).

## Données structurellement indisponibles en gratuit

Affichées `DATA UNAVAILABLE` — jamais fabriquées :
- **xG** : pas de source gratuite redistribuable validée
- **Blessures/suspensions** : pas de flux gratuit fiable multi-ligues
- **Compositions officielles** : idem (structure `lineups` prête)
- **Livescores mondiaux** : payants chez tous les fournisseurs sérieux

**MISSING DEPENDENCY — alternatives payantes** si besoin : API-Football (~10-30 $/mois),
Sportmonks (~39 €+/mois), Opta/Stats Perform (entreprise). L'architecture à adapters
permet de les brancher sans toucher aux moteurs.

## ESPN (ajoutée v3.1) + DEEP RESEARCH ENGINE

**ESPN — API JSON publique de scores** (`site.api.espn.com`, sans clé) :
- 33 compétitions mappées et vérifiées en ligne (2026-09-01) : les 16 divisions
  européennes, Saudi Pro League, MLS, Liga MX, Brésil, Argentine, Japon, Chine,
  A-League, Afrique du Sud, Ligue des Champions, Ligue Europa, Copa Libertadores ;
- 1 requête = 1 année civile complète d'une ligue (calendrier + résultats + stades) ;
- statuts live quasi temps réel → étend le suivi en direct au-delà d'OpenLigaDB ;
- usage poli : ≥1,2 s entre requêtes, cache HTTP, User-Agent identifiable avec
  URL de contact (format standard des robots) — jamais de contournement.

**DEEP RESEARCH ENGINE** (`src/engine/research.js`, worker toutes les 15 min) :
1. détecte chaque match programmé (≤96 h) dont une équipe (<8 matchs réels) ou la
   compétition (<60 matchs) manque d'historique — mesuré en base, jamais supposé ;
2. recherche en ligne ciblée : ESPN (2 années de la compétition), puis TheSportsDB
   (5 derniers matchs de chaque équipe encore en déficit, toutes compétitions) ;
3. régénère les pronostics des matchs concernés (garde §34 : un pronostic publié
   n'est jamais réécrit).
Si après recherche les données restent introuvables, l'application affiche
toujours l'état honnête « données insuffisantes » — la recherche élargit la
couverture, elle n'invente rien.

## v3.2 — Sélections du jour, suivi post-match, logos

- **Marché jamais par défaut** : tous les marchés cotés (1X2, double chance,
  plus/moins 2,5, BTTS) sont analysés ; seul le meilleur passe (§44) ou
  NO QUALIFIED PICK — inchangé, désormais visible sur chaque ligne match.
- **Pronostic Expert du jour** : pronostics ≥ 62 % de probabilité calibrée,
  % individuel + % global. **Combiné Safe du jour** : cote totale 2,5-3,6
  (~3), probabilité combinée maximale (produit des probabilités — MODEL
  ESTIMATE, hypothèse d'indépendance affichée). Les deux sont VERROUILLÉS au
  premier coup d'envoi puis réglés sur les scores réels.
- **Suivi post-match** : chaque match pronostiqué reçoit un compte rendu
  factuel (validé/non validé + faits de jeu recherchés via le résumé officiel
  ESPN, OpenLigaDB, stats source, météo). Rien d'observable = dit absent.
- **Bilans** : quotidien (validés/perdus/en cours) et hebdomadaire (par
  marché, unités) + **leçons du modèle** : calibration mesurée sur les
  résultats réels ; facteur de prudence appliqué UNIQUEMENT si un biais est
  prouvé (n ≥ 30), borné [0,85 ; 1].
- **Logos** : équipes (ESPN/TheSportsDB, recherche ciblée pour les matchs des
  72 h) et compétitions (logos officiels ESPN + TheSportsDB). Aucun logo
  deviné : correspondance stricte nom+pays, sinon initiale.
- **Bascule de jour** : au changement de date UTC, synchro + recherches +
  analyses des matchs du nouveau jour, sans mélange entre jours.

## v3.3 — Cotes ESPN (pickcenter) & Centre du match
- **Cotes bookmaker via ESPN** (`summary?event=` → `pickcenter`) : moneyline
  américaine convertie en cote décimale (DraftKings et autres providers ESPN).
  SOURCE DATA — débloque le Value Engine pour les ligues sans CSV coté
  (Saudi Pro League, J-League, MLS, Brésil…). Robot `espnOdds` toutes les 20 min.
- **Centre du match** (`/api/fixtures/:id/matchcenter`) : compositions
  officielles + formation, chronologie du jeu (buts/cartons/remplacements),
  statistiques officielles (possession, tirs, corners…), score/horloge live —
  100 % SOURCE DATA (ESPN). Scores exacts probables : MODEL ESTIMATE.
- **Pronostic d'analyse** : quand aucune cote n'existe (ou aucune value), le
  marché le plus probable du modèle calibré (p ≥ 58 %, < 98,5 %) est publié
  avec sa cote équitable 1/p — décision `ANALYSIS PICK`, jamais présentée
  comme VALUE BET. Les sections Expert/Combiné affichent la provenance.
- **Dédoublonnage inter-sources** des sélections du jour : même match réel
  détecté par équipes (préfixes complets ≥ 5 lettres) + coups d'envoi à ≤ 3 h.

## v3.4 — Pronos d'Or, Transparence, PWA, Handicaps, Bankroll
- **💎 Pronos d'Or** (`/api/golden-picks`) : picks les plus sûrs des 48 h tous
  marchés, étoiles (probabilité calibrée), fiabilité = % de réussite RÉEL du
  marché (CALCULATED DATA, affichée dès 10 pronostics réglés, sinon null).
- **📊 Transparence** (`/api/transparency`) : performance publique — réussite
  et ROI simulé (mise fixe 1 u.) par marché/compétition/décision + calibration
  annoncé-vs-réel + série 14 jours. Résultats réels réglés uniquement.
- **Handicaps asiatiques demi-lignes** (AH±0,5 / AH±1,5) : cotes spread du
  pickcenter ESPN (SOURCE DATA), probabilités exactes depuis la matrice de
  scores Dixon-Coles, règlement automatique dans evaluateSelection.
- **⚔️ Face-à-face** (`/api/fixtures/:id/h2h`) : confrontations réelles en base.
- **PWA** : manifest + service worker (shell en cache, API réseau uniquement —
  jamais de données périmées présentées comme fraîches), installable mobile.
- **🔔 Notifications navigateur** (SSE → Notification API) : sélections du
  jour, comptes rendus post-match, paris virtuels gagnés.
- **💰 Bankroll virtuelle** (localStorage, 1000 u. fictives) : suivi de mises
  virtuelles réglées sur les résultats réels — pédagogique, aucun argent réel.

## v3.5 — Forme, comparateur, calendrier, explications, archives

| Fonction | Source des données | Tag |
|---|---|---|
| 📈 Forme & momentum (`/api/fixtures/:id/form`) | Matchs **réellement terminés** en base (toutes compétitions ingérées) : série W/D/L des 10 derniers, points/match 5 derniers vs 5 précédents, splits domicile/extérieur | CALCULATED DATA |
| 🧮 Modèle vs Marché (`/api/model-vs-market`) | Pronostics pré-match en attente disposant d'une **probabilité implicite de marché** (cotes réelles ingérées, marge retirée) ; écart = p(modèle) − p(marché) | CALCULATED DATA (p marché = SOURCE DATA transformée) |
| 📅 Calendrier ±7 j (`/api/calendar`) | Comptes de matchs et de pronostics par jour, directement depuis les tables `fixtures`/`predictions` ; les jours sans match affichent 0 (jamais de remplissage inventé) | CALCULATED DATA |
| 🔍 « Pourquoi ce pronostic ? » (`/api/predictions/:id/explain`, `/api/fixtures/:id/explain`) | Phrases générées **uniquement** à partir de chiffres vérifiables en base (forme réelle, splits, dynamique, écart modèle/marché, qualité des données). Aucun texte libre inventé. | CALCULATED DATA |
| 🧾 Archives Expert/Combiné (`/api/selections/history`) | Table `daily_selections` : sélections immuables (§34) avec legs, statut réglé et bilan réel | SOURCE + CALCULATED DATA |
| 🏆 Classements enrichis | `form5` calculée depuis les résultats réels de la saison ; zones colorées **indicatives** (top 4 / 3 derniers), non présentées comme officielles | CALCULATED DATA |
| ⏰ Compte à rebours / 📤 partage | Heure de coup d'envoi (SOURCE DATA) ; partage via l'API Web Share du navigateur, aucun envoi serveur | SOURCE DATA |

## v3.6 — Backtest public, calibration, scores exacts, Elo, exports

| Fonction | Source des données | Tag |
|---|---|---|
| 🧪 Backtest value (`/api/backtest`) | Walk-forward strict par compétition (chaque match de test prédit uniquement avec les matchs antérieurs) ; ROI simulé à mise fixe 1 u. sur les **meilleures cotes réelles historiques** en base (football-data.co.uk : Bet365, Pinnacle, Max…) ; ventilation saison par saison | CALCULATED DATA |
| 📉 Calibration + Brier | Bins de calibration et score de Brier issus du même walk-forward, agrégés toutes compétitions pondérés par le nombre de matchs ; persistés dans `model_versions` à chaque entraînement | CALCULATED DATA |
| 🎯 Scores exacts (`/api/fixtures/:id/scorelines`) | Matrice de Poisson construite sur les buts attendus (λ) réellement stockés par le modèle (`model_outputs`) — jamais de score « au doigt mouillé » | MODEL ESTIMATE |
| 📈 Trajectoire Elo (`/api/teams/:id/elo-history`) | Elo **rejoué chronologiquement** sur les résultats réels de la compétition principale de l'équipe, même moteur qu'en production | CALCULATED DATA |
| 📥 Exports CSV (`/api/export/predictions.csv`, `/api/export/transparency.csv`) | Extraction directe des tables `predictions`/`fixtures` (UTF-8 BOM, séparateur « ; ») — vérifiabilité externe totale | SOURCE + CALCULATED DATA |
| 🌓 Thème clair/sombre | Préférence stockée en localStorage (`ps_theme`), aucun envoi serveur | — |
