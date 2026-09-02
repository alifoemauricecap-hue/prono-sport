# ⏰ Éveilleur gratuit — empêcher la mise en veille de Render Free

## Le problème
Le plan **Render Free** endort le service après **15 minutes sans trafic**.
Au réveil, PRONO SPORT doit re-télécharger et ré-analyser les données : **~10 minutes de démarrage**.
Un « éveilleur » (ping externe régulier) maintient le service éveillé **gratuitement**.

> Aucun self-ping interne n'est possible : quand le service dort, son propre code ne tourne plus.
> Il faut donc un service **externe** gratuit. Deux options fiables ci-dessous — une seule suffit.

## Option A — UptimeRobot (recommandé : ping toutes les 5 min + alertes)
1. Créer un compte gratuit : https://uptimerobot.com (50 moniteurs gratuits).
2. **+ New monitor** :
   - Monitor type : `HTTP(s)`
   - Friendly name : `PRONO SPORT`
   - URL : `https://prono-sport-5ast.onrender.com/api/health`
   - Monitoring interval : `5 minutes`
3. **Create monitor**. C'est tout : le site est pingé 24 h/24 et vous recevez un e-mail si le site tombe.

## Option B — cron-job.org (gratuit, jusqu'à 1 exécution/minute)
1. Créer un compte gratuit : https://cron-job.org
2. **Create cronjob** :
   - Title : `PRONO SPORT keep-alive`
   - URL : `https://prono-sport-5ast.onrender.com/api/health`
   - Schedule : `Every 5 minutes`
3. Sauvegarder. L'historique des exécutions montre le code HTTP 200 et le temps de réponse.

## Vérification
- `GET /api/health` répond `{"status":"UP", ...}` — c'est l'endpoint le plus léger de l'app (aucun calcul déclenché).
- Après ~20 min, ouvrir le site : il doit répondre immédiatement, sans écran de réveil Render.

## Limites honnêtes
- Render Free impose **750 h d'instance/mois** : un seul service maintenu éveillé 24 h/24 ≈ 720 h → OK pour un seul service, pas deux.
- L'éveilleur n'accélère pas le premier démarrage après un déploiement (bootstrap ~10 min inchangé).
- Ces services tiers sont gratuits pour cet usage ; aucune carte bancaire requise.
