# Journal des modifications

Toutes les modifications notables d'ez-dl sont consignées ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le projet suit le
[versionnement sémantique](https://semver.org/lang/fr/) et reste en `0.x` : une version mineure
peut donc contenir une rupture.

English version: [CHANGELOG.md](CHANGELOG.md).

Les entrées sous le titre `[Unreleased]` sont générées depuis les Conventional Commits au
moment où la CI publie une version ; ce qui est écrit à la main sous ce titre est conservé
au-dessus.

Artefacts publiés pour une version `X.Y.Z` :

- image Docker `ghcr.io/corentingc/ez-dl:X.Y.Z`, `:X.Y` et `:latest` (linux/amd64 + linux/arm64)
- le zip de l'extension servi par cette image sur `/extension`

La branche `main` publie de son côté `:edge` et `:main-<sha-court>` — non validés par un
processus de release, à réserver à qui suit le dépôt.

## [Unreleased]

## [0.1.2] - 2026-10-19

### Corrigé

- **security** : durcissement post-review overlay, proxy et copie inter-volumes (ez-dl-68t) (004153d)
- **extension** : les boutons overlay suivent le scroll sans latence (ez-dl-blo) (aee0ca0)
- **extension** : x.com télécharge la vidéo cliquée avec le titre du tweet (ez-dl-gap) (3cba43f)
- **server** : file de jobs fiable — annulation, arrêt, reprise, déplacement non bloquant (ez-dl-igv, ez-dl-s0w) (39b4ba0)
- **extension** : plus aucun probe en arrière-plan, probe à la demande (ez-dl-srp) (d321629)
- **server** : probe yt-dlp borné, plus de process fantômes + proxy EZDL_PROXY (ez-dl-nta, ez-dl-1oa) (37cb68d)
## [0.1.1] - 2026-08-22

### Corrigé

- **ci** : tirer la version des tags d'image du tag publié, pas de github.ref (ez-dl-xkl) (ae72dc9)
## [0.1.0] - 2026-08-22

Première version taguée. Tout ce qui suit existait déjà sur `main` ; cette version est le point
à partir duquel le projet est publié sous forme d'artefacts versionnés.

### Ajouté

- Serveur FastAPI : sondage des vidéos via yt-dlp, sélection de format, file de téléchargement,
  conversion ffmpeg optionnelle, progression en SSE, navigation dans les dossiers restreinte à
  `EZDL_DOWNLOAD_ROOTS`.
- Extension Chrome MV3 (WXT + React) : détection hybride (sonde yt-dlp + sniffing réseau + picker
  DOM), popup, page d'options, règles apprises par site.
- Authentification par mot de passe sur toutes les routes sauf `GET /api/health`, généré au
  démarrage si `EZDL_PASSWORD` est absent.
- Image Docker publiée sur GHCR en **linux/amd64 et linux/arm64**, extension buildée dedans et
  servie sur `/extension`.
- `PUID`/`PGID` en réglage d'exécution : l'entrypoint aligne l'utilisateur applicatif sur le
  propriétaire de vos volumes au démarrage du conteneur, si bien que l'image publiée fonctionne
  sur un hôte dont l'utilisateur n'est pas uid 1000.
- Mise à jour automatique opt-in dans le stack Docker (watchtower, profil compose `autoupdate`) et
  voie alternative par cron hôte pour les images construites localement.

[Unreleased]: https://github.com/CorentinGC/ez-dl/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/CorentinGC/ez-dl/releases/tag/v0.1.2
[0.1.1]: https://github.com/CorentinGC/ez-dl/releases/tag/v0.1.1
[0.1.0]: https://github.com/CorentinGC/ez-dl/releases/tag/v0.1.0
