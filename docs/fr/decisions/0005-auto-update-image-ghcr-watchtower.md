# ADR 0005 — Auto-update du serveur par image GHCR + watchtower

- **Statut** : acceptée
- **Date** : 2026-08-22

## Contexte

Le serveur tourne en self-hosted via `docker compose` sur un hôte personnel (NAS, home-lab).
Maintenir le déploiement à jour demandait des gestes manuels (`git pull` + `docker compose up -d
--build`) ou un cron côté hôte (`deploy/auto-update.sh`, ez-dl-z4q). Le besoin exprimé : une mise
à jour **intégrée au stack Docker**, sans rien installer ni programmer sur l'hôte.

Un conteneur ne peut pas se reconstruire lui-même de l'intérieur : l'auto-update « dans l'image »
passe nécessairement soit par un sidecar qui rebuild depuis les sources (accès au socket Docker
**et** au clone git, build coûteux sur l'hôte), soit par un registre d'images et un agent de mise
à jour standard.

## Décision

**La CI publie l'image, watchtower la tire** :

- Le job `publish` de la CI GitHub Actions construit l'image de production (extension embarquée,
  même chemin que le job de validation `docker`) et la pousse sur
  **`ghcr.io/corentingc/ez-dl`** (`latest` + sha) à chaque push sur `main` **dont les jobs lint,
  tests et build sont verts**. Aucun secret à gérer : `GITHUB_TOKEN` suffit pour GHCR.
- `docker-compose.yml` référence `image: ghcr.io/corentingc/ez-dl:latest` (surchargable par
  `EZDL_IMAGE`) tout en conservant `build:` — le dev local et les hôtes à `PUID`/`PGID` ≠ 1000
  continuent de builder avec `--build`, l'image publiée étant construite avec les valeurs par
  défaut.
- Un service **watchtower** (image épinglée `1.7.1`) vit dans le compose sous le **profil
  `autoupdate`** : opt-in par `COMPOSE_PROFILES=autoupdate` dans le `.env`, conforme à la règle
  « un flag dans le .env ». Il est confiné par `WATCHTOWER_LABEL_ENABLE` + `WATCHTOWER_SCOPE=ez-dl`
  (labels posés sur `server` et sur watchtower lui-même) : les autres stacks de l'hôte ne sont
  jamais touchées. `WATCHTOWER_CLEANUP` purge les images remplacées ;
  `EZDL_AUTO_UPDATE_INTERVAL_SECONDS` règle la période (défaut 300 s).

`deploy/auto-update.sh` reste l'**alternative** pour les hôtes qui buildent localement (autre
UID, variante GPU, pas d'accès registre) — les deux voies sont exclusives : watchtower
rétrograderait un build local vers l'image du registre.

## Conséquences

- Un push vert sur `main` se déploie seul en ~5 min sur tout hôte au profil `autoupdate` actif —
  plus aucun geste côté hôte.
- Le socket Docker est monté dans watchtower (équivalent root sur l'hôte) : accepté car le
  service n'expose aucun port, ne surveille que le scope `ez-dl`, et son image est épinglée.
- L'image publiée fige `PUID=1000` : les hôtes à UID différent gardent la voie build local + cron.
- La variante GPU (`FFMPEG_VARIANT=nvenc`) n'est pas publiée sur GHCR — build local uniquement.
