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

## ESPN (API publique) — ajoutée v1.2

- **Type** : API JSON publiquement accessible, sans clé ni authentification.
- **Rôle** : source du **moteur de recherche ciblée** (`src/workers/research.js`) :
  quand un match programmé n'a pas de pronostic faute d'historique (ex. Saudi
  Pro League), le moteur reconstitue l'historique réel de la compétition via
  le scoreboard ESPN (fenêtres de 45 jours, ~2 ans), puis régénère les pronostics.
- **Couverture vérifiée** (chaque slug testé réellement) : ksa.1 (Saudi Pro League),
  arg.1, bra.1, chn.1, jpn.1, mex.1, usa.1, aus.1, nor.1, swe.1, den.1, rsa.1, idn.1.
- **Live** : le worker `espnLive` (2 min) suit les matchs en cours de ces ligues.
- **Politesse (§5)** : ≥1,5 s entre requêtes, User-Agent identifiable, aucun
  contournement ; fiabilité mesurée comme toute source (`/api/sources`).
- **Attribution** : « Résultats et scores : ESPN ».

## Moteur de recherche ciblée (Deep Research Engine)

Toutes les 15 minutes (`researchTargeted`) :
1. détecte les compétitions avec matchs à venir (7 j) mais historique
   insuffisant (<60 matchs comp. ou <8 matchs/équipe) ;
2. cherche une source en ligne vérifiée couvrant la compétition ;
3. ingère l'historique **réel** (SOURCE DATA, provenance conservée) ;
4. régénère les pronostics.
Si aucune source gratuite ne couvre la compétition, le match reste honnêtement
en « données insuffisantes » — jamais de données inventées.
