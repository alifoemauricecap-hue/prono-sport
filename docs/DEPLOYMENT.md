# DEPLOYMENT — PRONO SPORT

## Prérequis

Node.js ≥ 20 · ~500 Mo de disque (base + cache) · accès sortant HTTPS.

## Local / VPS

```bash
npm ci --omit=dev
cp .env.example .env   # ajuster NODE_ENV=production
npm start
```

Derrière un reverse proxy (Caddy/Nginx) pour HTTPS. Systemd :

```ini
[Service]
WorkingDirectory=/opt/prono-sport
ExecStart=/usr/bin/node src/server.js
Restart=always
Environment=NODE_ENV=production
```

## Docker

```bash
docker build -t prono-sport .
docker run -d -p 3000:3000 -v prono_data:/app/data --restart unless-stopped prono-sport
```

## Render

`render.yaml` fourni — Blueprint : *New → Blueprint → repo*. Un disque persistant
est monté sur `/app/data` (la base doit survivre aux redéploiements).

## Railway / Koyeb / Replit

- **Railway** : deploy from repo, start command `npm start`, ajouter un volume sur `/app/data`.
- **Koyeb** : idem (Dockerfile détecté automatiquement).
- **Replit** : `npm start` (run command). Attention : stockage éphémère sur certains plans.

## Notes importantes (§90)

- Le **premier démarrage** télécharge ~50 CSV (1-3 min) : prévoir un healthcheck
  tolérant (`/api/health` répond immédiatement, les données arrivent en continu).
- Un hébergement gratuit suffit pour ce périmètre (16 divisions, sources gratuites),
  mais **pas** pour une collecte mondiale temps réel massive : prévoir PostgreSQL +
  Redis + workers dédiés pour passer à l'échelle (voir ARCHITECTURE.md).
- Instance unique recommandée (SQLite) ; passage multi-instances = migration PostgreSQL.

## CI/CD (§92)

Pipeline recommandé : commit → lint → `node --check` (typecheck syntaxique) →
`npm test` → audit (`npm audit`) → build image → staging → validation → production.
Exemple GitHub Actions : `.github/workflows/ci.yml` fourni.

## Monitoring (§91)

- `/api/health` — liveness
- `/api/admin/overview` — compteurs, jobs, RAM, uptime, conflits, modèles
- `/api/sources` — santé/latence/fiabilité de chaque source
- `sync_jobs` — journal complet des workers (statut, items, erreurs)

## Base de données & persistance

`DB_PATH` (`.env`) contrôle l'emplacement du fichier SQLite. En production,
pointez-le vers un **volume persistant** (Render Disk, volume Docker). Si la
base est absente au démarrage, le bootstrap **reconstruit automatiquement**
l'intégralité des données depuis les sources publiques (~80 000 matchs réels,
~1,1 M de cotes) en quelques minutes — aucune donnée n'est embarquée dans
l'image, tout vient des sources. Un checkpoint WAL périodique (5 min) garantit
la durabilité du fichier principal.

## Déploiement Render — pas à pas (plan free, 0 $)

1. **Dépôt Git** : créez un dépôt GitHub et poussez le dossier du projet
   (`git init && git add . && git commit -m "PRONO SPORT 3.0" && git push`).
   Le `.gitignore` exclut déjà `node_modules/`, la base et `.env`.
2. **Compte Render** : https://render.com → « Get Started » → connexion avec GitHub.
3. **Blueprint** : Dashboard → **New + → Blueprint** → sélectionnez le dépôt →
   Render lit `render.yaml` → **Apply**.
4. **Premier déploiement** (~5-8 min) : build `npm ci`, démarrage `npm start`,
   puis bootstrap autonome (~80 000 matchs, 2-3 min) visible dans **Logs**.
5. **Vérification** : `https://<votre-app>.onrender.com/api/health` puis l'UI à la racine.
6. **Limites du plan free** : mise en veille après 15 min d'inactivité
   (réveil ~1 min + re-bootstrap 2-3 min) ; 750 h/mois. Pour éviter cela :
   plan Starter + disque persistant (décommenter le bloc `disk` du render.yaml).
