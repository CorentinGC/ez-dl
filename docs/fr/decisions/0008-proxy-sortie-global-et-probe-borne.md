# ADR 0008 — Proxy de sortie global et probe borné

- **Statut** : acceptée
- **Date** : 2026-10-19
- **Complète** : [ADR 0001 — Détection hybride](0001-stack-fastapi-wxt.md) (côté probe yt-dlp)

## Contexte

Trois problèmes concrets sur le serveur déployé, et un besoin fonctionnel :

- **Saturation mémoire.** Une page de liste (résultats de recherche, chaîne, playlist, flux)
  envoyée à `/api/probe` faisait extraire à yt-dlp *chaque* entrée en RAM (`-J` sans
  `--flat-playlist`). Plusieurs probes simultanés suffisaient à faire tomber le conteneur par
  OOM. Les probes s'empilaient parce que le client abandonnait bien avant le serveur (popup
  rouverte, bouton relancé).
- **Process orphelins.** Le binaire yt-dlp standalone est un exécutable PyInstaller : un
  bootloader parent et un interpréteur enfant. Tuer le seul bootloader laisse l'enfant
  extraire, garder sa mémoire, puis bloquer sur un pipe que plus personne ne lit.
- **Contenus géo-restreints.** Il faut pouvoir faire sortir yt-dlp par un VPN, sans donner
  d'accès réseau au reste du serveur.

## Décision

### Probe borné par une règle playlist unique

Le probe et le téléchargement portent `--no-playlist --playlist-items N` (`N` = 1 par défaut) ;
`update()` et `version()` n'extraient pas de contenu et n'en ont pas besoin. Sans rang explicite,
le probe ajoute `--flat-playlist` : une page de liste est alors reconnue sans extraire ses
entrées, et répond **422** (« ouvrez une vidéo »). Avec un rang
`playlist_items` (entier 1–50), l'entrée `N` est extraite complètement, formats inclus.

`playlist_items` est accepté par `GET /api/probe` (query), `POST /api/probe` (corps) et
`POST /api/jobs`. Il permet de probe la bonne vidéo d'un tweet à plusieurs vidéos.

### Coordination des probes

`server/app/core/probe_cache.py` : 2 probes exécutés en même temps au maximum (sémaphore),
coalescing des appels identiques en vol (clé = URL + rang + empreinte SHA-256 du contexte
d'authentification, qui ne reste jamais en clair), cache des succès de 60 s, annulation de la
tâche quand son dernier demandeur part (le client déconnecté reçoit `499`), et groupe de process
tué au-delà de `EZDL_PROBE_TIMEOUT_SECONDS` (25 s par défaut).

### Arrêt du groupe de process

`server/app/core/process.py` : yt-dlp et ffmpeg sont lancés avec `start_new_session=True`. L'arrêt
signale le **groupe** (`os.killpg`) avec un garde-fou `pgid == pid`, pour ne jamais signaler le
groupe du serveur : SIGTERM, puis SIGKILL après 5 s, puis récolte du process.

### Proxy de sortie global

`EZDL_PROXY` (`http`, `https`, `socks5`, `socks5h`) est passé à yt-dlp en `--proxy`, pour le
probe, le téléchargement et l'auto-update. Le réglage est global à l'instance, pas par job :

- une valeur invalide refuse le démarrage, sans recopier la valeur dans l'erreur ; la validation
  est stricte (aucun espace ni caractère de contrôle, port valide si présent) ;
- l'URL n'est jamais journalisée en entier (schéma et hôte seulement) ;
- les identifiants d'URL (`user:pass@`) sont masqués (`***`) dans les messages d'erreur remontés
  par yt-dlp et ffmpeg (`redact_credentials` dans `server/app/core/process.py`) ;
- `GET /api/capabilities` n'expose que `proxy_enabled`, jamais l'URL.

ffmpeg n'est pas concerné par le proxy : il ne fait aucune requête réseau.

### Garde-fous de conteneur

`docker-compose.yml` : `init: true` (tini en PID 1, récolte des orphelins), `pids_limit: 512`,
`mem_limit: ${EZDL_MEM_LIMIT:-4g}`.

## Conséquences

- Une page de liste ne coûte plus une extraction complète : elle répond 422 immédiatement.
- Seul le trafic yt-dlp sort par le proxy. L'API, le SSE et l'écriture des fichiers restent
  directs.
- Une IP de VPN est souvent une IP d'hébergeur, que YouTube soumet plus souvent à son contrôle
  anti-bot. Le proxy ne garantit donc pas l'accès à tous les contenus.
- Le proxy est unique par instance : tous les jobs sortent par la même adresse. Un déploiement
  multi-utilisateurs ne peut pas choisir une sortie par utilisateur.
- Le cache de 60 s est indexé sur l'URL. Il peut servir un résultat périmé, dans la limite de la
  durée de vie des URL signées des CDN.
- Les constantes du coordinateur (2 probes, 60 s, 64 entrées) et le délai de grâce SIGTERM→SIGKILL
  (5 s) sont des constantes de code, **pas** des variables `EZDL_*`.
- `EZDL_PROXY` peut contenir des identifiants : il est traité comme un secret (jamais journalisé
  en entier, jamais exposé par l'API).

## Alternatives écartées

- **Proxy par job** : demande un champ d'API et un jeu d'identifiants qui traversent le client
  (l'extension). Trop de surface pour le besoin actuel ; reste une évolution possible.
- **Réseau du conteneur dans le VPN** (`network_mode: service:<vpn>`) : fait sortir tout le
  serveur, API comprise, et oblige le conteneur VPN à publier le port de l'API. Deux cycles de
  vie couplés et une surface élargie. Rejeté.
- **Borner le probe côté extension seulement** : nécessaire, mais insuffisant. La popup, le bouton
  d'overlay et les clients de l'API relancent les mêmes probes ; la borne doit être côté serveur.
