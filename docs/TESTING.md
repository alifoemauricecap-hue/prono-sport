# SECURITY & TESTING — PRONO SPORT

(Couvre SECURITY.md et TESTING.md — §72-§78.)

## Sécurité (§78)

- **Secrets** : uniquement côté serveur via `.env` (jamais dans le frontend ni le repo ; `.env.example` fourni)
- **Rate limiting** : 240 req/min/IP sur l'API (HTTP 429 au-delà)
- **Validation des entrées** : IDs numériques vérifiés, chaînes bornées, requêtes SQL 100 % paramétrées (aucune concaténation de valeurs utilisateur)
- **En-têtes** : `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `x-powered-by` désactivé
- **XSS** : tout contenu dynamique échappé côté client (`esc()`)
- **HTTPS** : terminé par le reverse proxy / la plateforme d'hébergement
- **Base** : FK activées, WAL, sauvegarde = copie du fichier `data/` (ou `litestream` pour du continu)
- **Respect des sources** : User-Agent identifiable, caches ETag, aucun contournement de protection, conditions d'utilisation enregistrées par source

## Tests (17, exécutés par `npm test`)

### `test/integrity.test.js`
- **NO FAKE DATA TEST (§72)** : aucun match sans provenance de source réelle ; toute source référencée doit exister au registre
- **DATA CONFLICT TEST (§73)** : source A 2-1 vs source B 1-1 ⇒ conflit journalisé, donnée originale conservée, règle documentée
- **VALIDATION CROISÉE (§6)** : deux sources concordantes ⇒ `VERIFIED`
- **DÉDUPLICATION (§60)** : alias d'équipes (Man United/Manchester United, Bayern…) fusionnent
- **PRONOSTICS IMMUABLES (§54)**
- parseur CSV robuste

### `test/engines.test.js`
- probabilités implicites : marge retirée, somme = 1
- formules Value documentées : fair odds = 1/P, EV = P×cote − 1
- Poisson : pmf exacte, matrice normalisée, cohérence des marchés
- Dixon-Coles : τ n'affecte que les petits scores
- **ANTI-FUITE (§34)** : les matchs futurs sont exclus de l'entraînement
- Elo : symétrie, normalisation, avantage domicile
- settlement exact de tous les marchés (marché inconnu ⇒ null, jamais deviné)

### `test/providers.test.js`
- **PROVIDER FAILURE (§77)** : source injoignable ⇒ `DEGRADED`, échec compté, aucune donnée simulée
- fiabilité strictement dérivée des observations (§8)
- chaque source déclare ses conditions d'utilisation (§5)

Les tests utilisent des bases isolées (chemins temporaires, imports dynamiques
après configuration) et ne touchent jamais la production (§70/§71).
