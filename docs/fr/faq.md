# FAQ

## Détection

**Un site n'est pas détecté ?**
Ouvrir la popup, cliquer sur « Aider à détecter », puis cliquer sur la vidéo dans la page. ez-dl
corrèle ce clic avec le trafic réseau récent et peut enregistrer une règle réutilisable pour ce
site. Voir [modules/apprentissage.md](modules/apprentissage.md).

**Est-ce que ça marche avec x.com / Twitter ?**
Oui, via yt-dlp. Activer l'envoi des cookies dans les options si le contenu demande une session
connectée.

**Et les services protégés par DRM (Netflix…) ?**
Non, et ça n'arrivera pas — voir *Cadre légal* dans le [README](../../README.fr.md#cadre-légal).
C'est explicitement hors périmètre.

## Serveur

**Pourquoi un mot de passe est-il obligatoire ?**
L'API déclenche des téléchargements et écrit des fichiers sur le disque. Sans authentification,
n'importe qui pouvant joindre le serveur sur le réseau pourrait lancer des téléchargements ou
remplir le stockage. Si `EZDL_PASSWORD` n'est pas défini, le serveur en génère un à **chaque**
démarrage et l'affiche dans les logs : le définir dans le `.env` donne un mot de passe stable.

**Les fichiers téléchargés appartiennent au mauvais utilisateur.**
Positionner `PUID`/`PGID` sur le propriétaire des volumes montés — voir
[setup.md](setup.md#identité-dexécution--puid--pgid). C'est un réglage d'exécution : aucun rebuild
d'image n'est nécessaire.

**Quelle différence entre les tags `latest` et `edge` ?**
`latest`, `X.Y.Z` et `X.Y` suivent les versions publiées (un tag git semver). `edge` et
`main-<sha>` suivent chaque commit vert de `main`, sans note de version ni garantie. Un
déploiement se met sur `latest`. Voir
[ADR 0006](decisions/0006-versionnement-et-canaux-de-publication.md).

**Le serveur ne se met pas à jour tout seul.**
Deux voies, exclusives l'une de l'autre : le service watchtower du compose
(`COMPOSE_PROFILES=autoupdate`, recommandé) ou `deploy/auto-update.sh` en cron côté hôte pour les
installations qui buildent localement. Voir
[setup.md](setup.md#mise-à-jour-automatique-du-serveur).

**NVENC ne fonctionne pas alors que le GPU est bien passé au conteneur.**
Le passthrough GPU ne suffit pas : le ffmpeg empaqueté par Debian n'inclut pas NVENC. Il faut la
variante d'image `FFMPEG_VARIANT=nvenc` (build local, amd64 uniquement) — voir
[modules/conversion.md](modules/conversion.md#support-nvenc-dans-limage-docker).

## Extension

**Chrome désactive l'extension ou l'oublie au redémarrage.**
Une extension chargée non empaquetée est relue depuis son dossier à chaque démarrage de Chrome :
ce dossier doit rester en place. Pour éviter le Mode développeur, passer par l'installation par
politique système — voir
[setup.md](setup.md#voie-sans-mode-développeur--installation-par-politique-système).

**Un bandeau annonce une nouvelle version de l'extension.**
Le serveur publie l'extension embarquée dans son image : après une mise à jour du serveur, le zip
de `/extension` peut être plus récent que l'extension chargée dans Chrome. Le remplacer et
recharger l'extension — voir [setup.md](setup.md#republier-lextension).
