# syntax=docker/dockerfile:1
#
# Image du serveur ez-dl (FastAPI + yt-dlp + ffmpeg).
# Contexte de build attendu : ./server (voir docker-compose.yml).
#
# ARG FFMPEG_VARIANT (debian|nvenc, défaut: debian) — sélectionne la provenance de
# ffmpeg/ffprobe dans l'image finale :
#   - debian : paquet ffmpeg du dépôt Debian (apt). Comportement historique inchangé.
#     N'inclut PAS NVENC (dépendances non-libres exclues des dépôts officiels Debian).
#   - nvenc  : binaire statique BtbN/FFmpeg-Builds, variante `linux64-gpl` (self-contained,
#     inclut l'encodage matériel NVIDIA NVENC). Uniquement disponible en amd64 : BtbN ne
#     publie pas de build `linux64` pour arm64. Sans conséquence pratique puisque NVENC est
#     une technologie NVIDIA (pas de carte NVIDIA sur les hôtes arm64 typiques).
#     Sélection : `docker build --build-arg FFMPEG_VARIANT=nvenc ./server`
#     (docker-compose.gpu.yml positionne cet arg automatiquement).
ARG FFMPEG_VARIANT=debian

# =============================================================================
# Stage ffmpeg-nvenc — binaire statique BtbN/FFmpeg-Builds (linux64-gpl, inclut NVENC)
#
# Stage dédié pour le cache : le téléchargement (~90 Mo) reste en cache tant que l'URL
# ne change pas, indépendamment du reste du build. Ce stage n'est construit par BuildKit
# que si FFMPEG_VARIANT=nvenc (résolu via le stage `final-${FFMPEG_VARIANT}` plus bas) —
# la variante debian par défaut ne le télécharge donc jamais. Le build BtbN GPL est
# statiquement lié (aucune dépendance partagée hors libc) : copier uniquement les deux
# binaires suffit, contrairement au paquet ffmpeg Debian (voir stage `final-debian`, qui a
# besoin de ses dépendances partagées libavcodec/libx264/... installées par apt).
# =============================================================================
FROM python:3.13-slim-bookworm AS ffmpeg-nvenc

# BtbN ne publie un build `linux64` que pour amd64 : on échoue explicitement plutôt que
# de laisser passer un binaire incompatible si l'image est construite pour une autre
# plateforme (ex: arm64 via `docker buildx build --platform linux/arm64`).
ARG TARGETARCH
RUN if [ "${TARGETARCH}" != "amd64" ]; then \
        echo "FFMPEG_VARIANT=nvenc requiert une plateforme amd64 (BtbN linux64-gpl) ; TARGETARCH=${TARGETARCH} n'est pas supporte." >&2; \
        exit 1; \
    fi

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
        curl \
        xz-utils \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# URL "latest" stable : suit toujours la dernière release BtbN sans figer de date de build.
RUN curl -fL --retry 3 -o /tmp/ffmpeg.tar.xz \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz" \
    && mkdir -p /tmp/ffmpeg-extract /out \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-extract --strip-components=1 \
    && cp /tmp/ffmpeg-extract/bin/ffmpeg /tmp/ffmpeg-extract/bin/ffprobe /out/ \
    && chmod 755 /out/ffmpeg /out/ffprobe \
    && rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-extract

# =============================================================================
# Stage extension — sources de l'extension Chrome, fournies en CONTEXTE NOMMÉ
#
# Le contexte de build du serveur est ./server : le dossier ../extension n'y est pas
# visible. docker-compose passe donc `additional_contexts: extension: ./extension`, et
# BuildKit substitue ce contexte à ce stage (un contexte nommé l'emporte sur un stage de
# même nom). Sans lui — `docker build` lancé à la main dans server/ — le stage reste vide
# et la construction du zip est simplement sautée : l'image se construit normalement, seule
# la distribution via /extension est indisponible.
# =============================================================================
FROM scratch AS extension

# =============================================================================
# Stage extension-zip — build WXT de l'extension et empaquetage du zip publié
#
# Node n'existe QUE dans ce stage : l'image finale ne récupère que le zip et sa version.
# La version est lue depuis extension/package.json, seule source de vérité (WXT l'injecte
# aussi dans le manifest) ; le serveur la republie sur /extension/version.
# =============================================================================
# --platform=$BUILDPLATFORM : ce stage ne produit qu'un zip et un fichier texte, rien de
# natif. Sans ce flag, un build multi-arch relance `npm ci && npm run zip` une fois par
# plateforme cible — sous émulation pour les autres arch, soit plusieurs minutes pour un
# résultat identique au bit près.
FROM --platform=$BUILDPLATFORM node:22-slim AS extension-zip

WORKDIR /ext

# Les sources arrivent par un BIND MOUNT et non par un `COPY --from=extension` : la clé de
# cache d'un `COPY --from=<stage>` ignore le contenu réel du contexte nommé, si bien qu'une
# fois ce stage en cache BuildKit le réutilisait tel quel — un bump de version dans
# extension/package.json ne produisait plus jamais de nouveau zip, et un build sans contexte
# suivi d'un build avec (ou l'inverse) donnait silencieusement le mauvais résultat. Le
# contenu d'un bind mount, lui, entre bien dans la clé de cache du RUN.
#
# Le montage est en lecture seule : les sources sont recopiées dans /ext avant le build.
# /out est créé dans tous les cas — le COPY de l'image finale doit réussir même sans
# contexte `extension` (montage vide, donc pas de package.json, build sauté).
# rm -rf : un .output ou un node_modules venu de l'hôte fausserait le zip publié.
RUN --mount=type=bind,from=extension,target=/src \
    --mount=type=cache,target=/root/.npm \
    mkdir -p /out \
    && if [ -f /src/package.json ]; then \
        cp -R /src/. /ext/ \
        && rm -rf .output node_modules \
        && npm ci \
        && npm run zip \
        && cp .output/*-chrome.zip /out/ez-dl-extension.zip \
        && node -p "require('./package.json').version" > /out/extension-version.txt; \
    fi

# =============================================================================
# Stage builder — résout et installe les dépendances Python via uv
# =============================================================================
FROM python:3.13-slim-bookworm AS builder

# Toolchain de compilation : certaines dépendances transitives peuvent ne pas
# fournir de wheel précompilée pour toutes les plateformes (ex: build arm64).
# Ce stage est jeté après le build, aucun coût sur l'image finale.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Binaire uv récupéré directement depuis l'image officielle Astral (pas de pip/curl).
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /bin/

# UV_LINK_MODE=copy : le cache uv (bind-mounté) et /app sont sur des filesystems
# différents, le hardlink par défaut échouerait silencieusement en copie complète.
# UV_COMPILE_BYTECODE : précompile les .pyc à l'installation (démarrage plus rapide).
# UV_PYTHON_DOWNLOADS=0 : n'utilise que le Python de l'image, jamais de téléchargement.
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# On copie d'abord uniquement les fichiers de dépendances : ce layer (le plus lent,
# résolution + téléchargement des paquets) reste en cache tant que pyproject.toml
# et uv.lock ne changent pas, même si le code applicatif est modifié ensuite.
# --no-install-project : on installe seulement les dépendances, pas le paquet local
# lui-même (le service est lancé via `uvicorn app.main:app`, pas comme paquet installé
# — inutile de dépendre de la config de packaging du pyproject.toml applicatif).
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Code applicatif copié après : ne casse pas le cache de la couche de dépendances.
COPY . .

# =============================================================================
# Stage final-base — commun aux deux variantes : tout sauf l'installation de ffmpeg
# =============================================================================
FROM python:3.13-slim-bookworm AS final-base

# UID/GID de l'utilisateur applicatif CRÉÉ dans l'image. Ce ne sont que des valeurs de
# départ : docker-entrypoint.sh réaligne l'utilisateur sur les variables d'environnement
# PUID/PGID au démarrage du conteneur. Une image publiée (donc buildée avec les valeurs
# par défaut) fonctionne ainsi sur un hôte dont l'utilisateur n'est pas 1000, sans rebuild.
ARG PUID=1000
ARG PGID=1000

# ca-certificates : TLS pour les appels sortants (yt-dlp, self-update, extracteurs).
# curl : utilisé par le HEALTHCHECK et pour télécharger le binaire yt-dlp ci-dessous.
# gosu : abandon des privilèges dans docker-entrypoint.sh. Contrairement à `su` ou `sudo`,
# gosu remplace le process (exec) sans en créer un second : uvicorn reste le PID 1 du
# conteneur et reçoit directement SIGTERM.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gosu \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp STANDALONE officiel (pas la version pip) : requis pour que l'auto-update
# `yt-dlp -U` au démarrage et périodique (EZDL_YTDLP_UPDATE_INTERVAL_HOURS) fonctionne.
# Le lien "latest/download" suit toujours la dernière release sans figer une date de build.
# Binaire choisi selon l'architecture cible : un yt-dlp_linux (x86_64) codé en dur casse
# sur arm64 (Apple Silicon) avec « rosetta error: failed to open elf ».
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
        amd64) YTDLP_ASSET="yt-dlp_linux" ;; \
        arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;; \
        *) echo "Architecture non supportée pour yt-dlp : TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fL --retry 3 -o /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" \
    && chmod 755 /usr/local/bin/yt-dlp

# Runtime JavaScript requis par yt-dlp pour YouTube. Depuis la dépréciation EJS, sans
# runtime JS l'extracteur ne résout plus les challenges du player : la liste de formats
# revient amputée (aucun format muxé, apparition de formats « Premium » non téléchargeables)
# et, quand il ne reste plus rien de jouable, `yt-dlp -J` sort en erreur avec
# « Requested format is not available » — remonté en 502 par /api/probe (ez-dl-b6e).
# Deno est le seul runtime activé par défaut par yt-dlp (aucun `--js-runtimes` à passer).
# L'image `bin` officielle ne contient que le binaire statique et est publiée en amd64
# comme en arm64 : pas de sélection par TARGETARCH à faire ici.
COPY --from=denoland/deno:bin-2.9.5 /deno /usr/local/bin/deno

# Utilisateur non-root dédié. Le binaire yt-dlp est chown vers cet utilisateur
# (et non laissé root:root) car `-U` doit pouvoir se remplacer lui-même sur disque.
# Deno exige un cache accessible en écriture : il vit sous le HOME de l'utilisateur, et
# surtout pas dans EZDL_TEMP_DIR qui est monté en tmpfs (vidé à chaque redémarrage).
RUN groupadd --gid "${PGID}" ezdl \
    && useradd --uid "${PUID}" --gid "${PGID}" --create-home --shell /usr/sbin/nologin ezdl \
    && chown "${PUID}:${PGID}" /usr/local/bin/yt-dlp \
    && mkdir -p /home/ezdl/.cache/deno \
    && chown -R "${PUID}:${PGID}" /home/ezdl/.cache

# Dossier de travail des téléchargements (EZDL_TEMP_DIR) + sous-dossier des cookie-jars.
# Créés et attribués à l'utilisateur applicatif ICI parce qu'un volume nommé vide est
# initialisé par docker à partir du contenu de l'image, propriétaire compris : sans ce
# mkdir/chown, le volume monté sur /tmp/ez-dl appartiendrait à root et le serveur non-root
# ne pourrait pas y écrire (le compose monte ce chemin en volume nommé pour permettre la
# reprise des téléchargements interrompus).
RUN mkdir -p /tmp/ez-dl/cookies \
    && chown -R "${PUID}:${PGID}" /tmp/ez-dl

WORKDIR /app

# Venv déjà résolu, copié tel quel : l'image finale ne contient ni compilateur ni
# cache uv. Le code source est copié séparément (même chemin /app que le builder,
# nécessaire car uv sync a pu créer des références relatives dans le venv).
COPY --from=builder --chown=${PUID}:${PGID} /app/.venv /app/.venv
COPY --chown=${PUID}:${PGID} . .

# Zip de l'extension + sa version (EZDL_EXTENSION_DIST_DIR), servis par /extension. Dossier
# vide quand l'image est construite sans contexte `extension`. À copier APRÈS le code
# applicatif : un `COPY . .` postérieur écraserait /app et emporterait ces artefacts.
#
# root:root et non l'utilisateur applicatif : le serveur ne fait que LIRE ces artefacts, et
# il signe le zip qu'il y trouve avec sa clé persistante. Un zip réécrit par le process
# produirait un `.crx` au même identifiant Chrome que l'extension légitime — donc une mise à
# jour silencieuse conservant les permissions déjà accordées. Le dossier reste inscriptible
# par root uniquement, hors de portée du process non-root.
COPY --from=extension-zip --chown=root:root /out/ /app/extension-dist/

# Entrypoint hors de /app et root:root : il s'exécute avec les privilèges root avant le
# passage à l'utilisateur applicatif, il ne doit donc jamais être modifiable par ce
# dernier. --chmod plutôt qu'un chmod dans un RUN : le bit exécutable ne dépend alors pas
# des permissions du fichier sur la machine qui construit l'image.
COPY --chmod=755 --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# HOME/DENO_DIR explicites : Docker ne dérive pas toujours HOME de /etc/passwd quand USER
# est positionné, et un Deno sans cache inscriptible fait échouer l'extraction YouTube.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    HOME=/home/ezdl \
    DENO_DIR=/home/ezdl/.cache/deno

# =============================================================================
# Stage final-debian — ffmpeg via apt (comportement historique, variante par défaut)
# =============================================================================
FROM final-base AS final-debian

# ffmpeg/ffprobe (contrat EZDL_FFMPEG_BINARY) : paquet Debian. Ses dépendances partagées
# (libavcodec, libx264, libmp3lame...) sont installées dans ce même layer par apt — c'est
# pourquoi cette variante installe ffmpeg ici plutôt que de copier un binaire isolé.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage final-nvenc — ffmpeg statique BtbN (linux64-gpl, inclut NVENC)
# =============================================================================
FROM final-base AS final-nvenc

# Binaire statique (aucune lib partagée à installer) copié depuis le stage ffmpeg-nvenc.
COPY --from=ffmpeg-nvenc /out/ffmpeg /out/ffprobe /usr/local/bin/

# =============================================================================
# Stage final — résout FFMPEG_VARIANT vers final-debian ou final-nvenc.
#
# `FROM` (contrairement à `COPY --from=`) supporte l'expansion d'un ARG de portée globale
# (FFMPEG_VARIANT, déclaré avant le tout premier FROM du fichier) — c'est le mécanisme de
# sélection de variante documenté par BuildKit. BuildKit ne construit alors que le stage
# effectivement référencé (final-debian OU final-nvenc), jamais les deux : la variante
# debian par défaut ne télécharge donc jamais le binaire BtbN, et inversement.
# =============================================================================
FROM final-${FFMPEG_VARIANT} AS final

# Pas de `USER ezdl` ici, volontairement : docker-entrypoint.sh a besoin des privilèges
# root pour rendre /config, EZDL_TEMP_DIR et les racines de téléchargement inscriptibles
# par ${PUID}:${PGID} — ce que seul root peut faire, et qui est indispensable dès que
# l'hôte n'utilise pas l'uid 1000 (NAS, Raspberry Pi). L'entrypoint repasse ensuite à
# l'utilisateur applicatif via gosu : aucun code applicatif ne s'exécute en root.
# Conséquences à connaître : le HEALTHCHECK ci-dessous et un `docker exec` sans --user
# s'exécutent, eux, en root. Le premier ne fait qu'une requête HTTP locale sans écriture.
# Pour retrouver un conteneur non-root de bout en bout, fixer `user:` dans compose : dans
# ce cas l'entrypoint détecte qu'il n'est pas root, ne tente aucun chown et exec directement
# — c'est alors à l'hôte de fournir des volumes déjà inscriptibles.

EXPOSE 8000

# start-period généreux : le premier démarrage lance `yt-dlp -U` (réseau) et
# initialise la base SQLite, ce qui peut prendre du temps sur un NAS/CPU lent.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${EZDL_PORT:-8000}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Forme shell + exec : substitue les variables d'env puis remplace le process shell
# (exec) pour que uvicorn reçoive directement SIGTERM et s'arrête proprement.
CMD ["sh", "-c", "exec uvicorn app.main:app --host ${EZDL_HOST:-0.0.0.0} --port ${EZDL_PORT:-8000}"]
