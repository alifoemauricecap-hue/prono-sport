// PRONO SPORT — Configuration centrale
// Les secrets ne sont JAMAIS exposés au frontend (voir SECURITY.md)
import 'node:process';

export const CONFIG = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || './data/pronosport.db',

  // Clé optionnelle football-data.org (améliore la couverture si fournie)
  footballDataOrgKey: process.env.FOOTBALL_DATA_ORG_KEY || '',
  // Clé TheSportsDB (la clé de test publique "123" est documentée par TheSportsDB)
  theSportsDbKey: process.env.THESPORTSDB_KEY || '123',

  // Fenêtres de synchronisation (ms) — priorités §10
  syncIntervals: {
    live: 60 * 1000,            // P1 : matchs live
    upcoming: 10 * 60 * 1000,   // P2/P3 : matchs à venir + cotes
    results: 15 * 60 * 1000,    // résultats / settlement
    historical: 24 * 3600 * 1000, // P7 : historique
    discovery: 6 * 3600 * 1000, // P8 : découverte / santé des sources
  },

  // Fraîcheur (§11) — seuils en secondes par catégorie
  freshness: {
    live: 180,
    fixtures: 3600 * 6,
    odds: 3600 * 12,
    results: 3600 * 24,
    historical: 3600 * 24 * 14,
    weather: 3600 * 3,
  },

  // Value Bet Engine (§40) — critères documentés
  value: {
    minEdge: 0.03,          // edge minimal 3 % vs cote moyenne du marché
    minEV: 0.02,            // EV minimal +2 %
    minModelProb: 0.05,     // ne jamais parier sur des probabilités infimes
    minDataQuality: 0.55,   // qualité de données minimale
    minMatchesPerTeam: 8,   // profondeur minimale d'historique par équipe
  },

  // Historique : saisons football-data.co.uk à charger (codes réels du site)
  historicalSeasons: (process.env.HISTORICAL_SEASONS || '2324,2425,2526').split(','),

  // Divisions couvertes par football-data.co.uk (métadonnées de la source, pas des données inventées)
  divisions: {
    E0: { name: 'Premier League', country: 'Angleterre', tsdbLeagueId: '4328' },
    E1: { name: 'Championship', country: 'Angleterre', tsdbLeagueId: '4329' },
    SP1: { name: 'La Liga', country: 'Espagne', tsdbLeagueId: '4335' },
    SP2: { name: 'La Liga 2', country: 'Espagne', tsdbLeagueId: '4400' },
    D1: { name: 'Bundesliga', country: 'Allemagne', tsdbLeagueId: '4331' },
    D2: { name: '2. Bundesliga', country: 'Allemagne', tsdbLeagueId: '4399' },
    I1: { name: 'Serie A', country: 'Italie', tsdbLeagueId: '4332' },
    I2: { name: 'Serie B', country: 'Italie', tsdbLeagueId: '4394' },
    F1: { name: 'Ligue 1', country: 'France', tsdbLeagueId: '4334' },
    F2: { name: 'Ligue 2', country: 'France', tsdbLeagueId: '4401' },
    N1: { name: 'Eredivisie', country: 'Pays-Bas', tsdbLeagueId: '4337' },
    B1: { name: 'Pro League', country: 'Belgique', tsdbLeagueId: '4338' },
    P1: { name: 'Primeira Liga', country: 'Portugal', tsdbLeagueId: '4344' },
    T1: { name: 'Süper Lig', country: 'Turquie', tsdbLeagueId: '4339' },
    SC0: { name: 'Premiership', country: 'Écosse', tsdbLeagueId: '4330' },
    G1: { name: 'Super League', country: 'Grèce', tsdbLeagueId: '4336' },
  },

  // Ligues mondiales publiées par football-data.co.uk (/new/<code>.csv) —
  // historique complet depuis ~2012 + cotes réelles (Pinnacle, Bet365, Betfair,
  // moyennes/max du marché) + fixtures à venir cotées (new_league_fixtures.csv).
  // tsdbLeagueId : uniquement les correspondances VÉRIFIÉES par test individuel ;
  // tsdbMatch : motif utilisé par le moteur de découverte pour rattacher
  // automatiquement une ligue TheSportsDB testée à cette compétition (fusion).
  extraLeagues: {
    ARG1: { file: 'ARG', name: 'Liga Profesional', country: 'Argentina', tsdbLeagueId: '4406', tsdbMatch: /primera divisi|liga profesional/i },
    AUT1: { file: 'AUT', name: 'Bundesliga (Autriche)', country: 'Austria', tsdbMatch: /austrian bundesliga/i },
    BRA1: { file: 'BRA', name: 'Série A (Brésil)', country: 'Brazil', tsdbLeagueId: '4351', tsdbMatch: /brazilian serie a/i },
    CHN1: { file: 'CHN', name: 'Super League (Chine)', country: 'China', tsdbLeagueId: '4359', tsdbMatch: /chinese super league/i },
    DNK1: { file: 'DNK', name: 'Superliga', country: 'Denmark', tsdbMatch: /danish superliga/i },
    FIN1: { file: 'FIN', name: 'Veikkausliiga', country: 'Finland', tsdbMatch: /veikkausliiga/i },
    IRL1: { file: 'IRL', name: 'Premier Division', country: 'Ireland', tsdbMatch: /irish premier|league of ireland/i },
    JPN1: { file: 'JPN', name: 'J1 League', country: 'Japan', tsdbMatch: /j.?league|j1/i },
    MEX1: { file: 'MEX', name: 'Liga MX', country: 'Mexico', tsdbLeagueId: '4350', tsdbMatch: /liga mx/i },
    NOR1: { file: 'NOR', name: 'Eliteserien', country: 'Norway', tsdbLeagueId: '4358', tsdbMatch: /eliteserien/i },
    POL1: { file: 'POL', name: 'Ekstraklasa', country: 'Poland', tsdbMatch: /ekstraklasa/i },
    ROU1: { file: 'ROU', name: 'Liga I', country: 'Romania', tsdbMatch: /romanian liga/i },
    RUS1: { file: 'RUS', name: 'Premier League (Russie)', country: 'Russia', tsdbMatch: /russian premier/i },
    SWE1: { file: 'SWE', name: 'Allsvenskan', country: 'Sweden', tsdbMatch: /allsvenskan/i },
    SWZ1: { file: 'SWZ', name: 'Super League (Suisse)', country: 'Switzerland', tsdbMatch: /swiss super league/i },
    USA1: { file: 'USA', name: 'MLS', country: 'United States', tsdbLeagueId: '4346', tsdbMatch: /major league soccer/i },
  },

  // Graines du SOURCE DISCOVERY ENGINE : IDs de ligues TheSportsDB candidates.
  // Ce sont des CANDIDATS à tester — chaque ID passe par TEST → VALIDATE
  // (sport = Soccer vérifié, événements réellement disponibles) → APPROVE/REJECT.
  tsdbSeedLeagueIds: ['4346', '4350', '4351', '4356', '4358', '4359', '4406', '4668'],

  // Nombre de ligues découvertes synchronisées par cycle (respect des limites
  // du tier gratuit de la source — throttling documenté)
  discoveryBatchSize: 8,
  dynamicSyncBatchSize: 10,


  modelVersion: 'ensemble-1.0.0',
  featuresVersion: 'features-1.0.0',
};

export const DATA_TAGS = {
  SOURCE: 'SOURCE DATA',
  CALCULATED: 'CALCULATED DATA',
  MODEL: 'MODEL ESTIMATE',
};

export const FRESHNESS = { FRESH: 'FRESH', STALE: 'STALE', UNKNOWN: 'UNKNOWN', INVALID: 'INVALID' };

export const MATCH_STATUS = [
  'SCHEDULED', 'UPCOMING', 'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES',
  'FINISHED', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'ABANDONED', 'UNKNOWN',
];
