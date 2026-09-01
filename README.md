# ⚽ PRONO SPORT

**PLATEFORME PROFESSIONNELLE MONDIALE D'INTELLIGENCE FOOTBALL**

> # LES DONNÉES D'ABORD.
> # LES MODÈLES ENSUITE.
> # LA DÉCISION EN DERNIER.

PRONO SPORT est une infrastructure d'analyse football : collecte continue de données réelles multi-sources, fusion et validation croisée, modèles statistiques (Elo, Poisson, Dixon-Coles, ensemble validé par backtest walk-forward), moteur de cotes réelles, détection de Value Bets et suivi immuable des pronostics.

## Règle absolue : AUCUNE DONNÉE INVENTÉE

Chaque information affichée est taguée :

| Tag | Signification |
|---|---|
| `SOURCE DATA` | provient directement d'une source réelle vérifiable |
| `CALCULATED DATA` | calculée par PRONO SPORT à partir de données réelles |
| `MODEL ESTIMATE` | estimation d'un modèle statistique entraîné sur données réelles |

Quand une donnée manque, la plateforme affiche `DATA UNAVAILABLE`, `INSUFFICIENT DATA`, `WEATHER DATA UNAVAILABLE` ou `NO QUALIFIED PICK` — jamais une valeur fabriquée. Les tests automatiques `NO FAKE DATA` et `DATA CONFLICT` le garantissent.

## Sources réelles utilisées (gratuites, testées, monitorées)

| Source | Données | Conditions |
|---|---|---|
| [Football-Data.co.uk](https://www.football-data.co.uk) | Historique Europe (16 divisions, stats complètes) **+ 16 ligues mondiales depuis 2012** (Brésil, Argentine, MLS, Japon, Mexique, Chine, Scandinavie…) + **cotes réelles** (Bet365, Betfair, Pinnacle…) y compris fixtures mondiales cotées | CSV publics gratuits, attribution recommandée |
| [TheSportsDB](https://www.thesportsdb.com) | Calendriers, résultats, logos, stades — **découverte autonome de ligues mondiales** (TEST → VALIDATE → APPROVE) | API gratuite, clé de test publique documentée |
| [OpenLigaDB](https://api.openligadb.de) | Bundesliga 1/2 : scores et buteurs quasi temps réel | Open data communautaire |
| [Open-Meteo](https://open-meteo.com) | Météo au coup d'envoi + géocodage | Gratuit, attribution demandée |
| [football-data.org](https://www.football-data.org) | Optionnel (clé gratuite) | Tier gratuit officiel |
| StatsBomb Open Data · openfootball | Candidates surveillées par le Source Monitor (xG historique, failover résultats) | Open data avec licence publiée |

**Jamais de dépendance à une source unique** : matchs et résultats croisés entre 2-3 sources indépendantes (statut `VERIFIED`), failover automatique, et le **Source Discovery Engine** teste en continu de nouveaux candidats (scan par pays, throttlé, respect des rate limits — une ligue n'est jamais utilisée sans validation). La fiabilité de chaque source est **mesurée** (succès/échecs/latence observés), jamais déclarée.

## Démarrage rapide

```bash
npm install
cp .env.example .env
npm start          # http://localhost:3000
npm test           # 29 tests : intégrité, moteurs, live, xG-proxy, classements, providers, découverte
```

Au premier démarrage, la plateforme charge **~80 000 matchs réels** (Europe 3 saisons + monde depuis 2012, 34+ compétitions), ~600 000 cotes réelles, puis les workers prennent le relais (live 60 s, fixtures 10 min, résultats 15 min, ligues découvertes 20 min, découverte de sources 6 h).

## Fonctionnalités

- **Accueil / Live / À venir / Terminés** — statuts complets (SCHEDULED → LIVE → FINISHED…), le statut LIVE n'est affiché que confirmé par une source
- **Match Center** — onglets Aperçu, Stats, Cotes, Analyse, Pronostics, Météo
- **Value Bet Engine** — `edge = P_modèle − P_marché(sans marge)`, `EV = P×cote − 1`, seuils documentés, `NO QUALIFIED PICK` si rien ne qualifie
- **Backtest Lab** — walk-forward sans fuite temporelle, Brier/LogLoss/calibration par compétition
- **Pronostics** — audit trail complet, immuables, réglés WIN/LOSS/VOID sur résultats réels (paper tracking)
- **Coverage Center** — couverture AVAILABLE/PARTIAL/UNAVAILABLE mesurée sur la base
- **Source Monitor & Admin Panel** — santé des sources, jobs de sync, conflits de données, modèles
- **Assistant IA** — répond uniquement à partir des données collectées
- **Recherche globale, favoris, SSE temps réel, mobile-first**

## Documentation

`docs/` : [ARCHITECTURE](docs/ARCHITECTURE.md) · [DATABASE](docs/DATABASE.md) · [DATA_SOURCES](docs/DATA_SOURCES.md) · [DATA_PIPELINE](docs/DATA_PIPELINE.md) · [LIVE](docs/LIVE.md) · [ANALYTICS](docs/ANALYTICS.md) · [ML](docs/ML.md) · [ODDS](docs/ODDS.md) · [VALUE_BETS](docs/VALUE_BETS.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md)

## Déploiement

Prêt pour Render / Railway / Koyeb / Replit / VPS / Docker — voir [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
docker build -t prono-sport . && docker run -p 3000:3000 -v prono_data:/app/data prono-sport
```

## Avertissement

Plateforme d'analyse statistique à but informatif. Les probabilités sont des estimations de modèles, pas des certitudes. Jouer comporte des risques : endettement, isolement, dépendance.
