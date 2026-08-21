# syntax=docker/dockerfile:1
#
# Image du serveur ez-dl (FastAPI + yt-dlp + ffmpeg).
# Contexte de build attendu : ./server (voir docker-compose.yml).

# =============================================================================
# Stage 1/2 : builder — résout et installe les dépendances Python via uv
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
# Stage 2/2 : image finale — runtime minimal, non-root, ffmpeg + yt-dlp standalone
# =============================================================================
FROM python:3.13-slim-bookworm

# UID/GID paramétrables pour aligner l'utilisateur du conteneur avec le propriétaire
# des volumes montés (NAS, partage réseau, etc.) et éviter les problèmes de droits.
ARG PUID=1000
ARG PGID=1000

# ffmpeg/ffprobe : conversion vidéo (contrat EZDL_FFMPEG_BINARY).
# ca-certificates : TLS pour les appels sortants (yt-dlp, self-update, extracteurs).
# curl : utilisé par le HEALTHCHECK et pour télécharger le binaire yt-dlp ci-dessous.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp STANDALONE officiel (pas la version pip) : requis pour que l'auto-update
# `yt-dlp -U` au démarrage et périodique (EZDL_YTDLP_UPDATE_INTERVAL_HOURS) fonctionne.
# Le lien "latest/download" suit toujours la dernière release sans figer une date de build.
RUN curl -fL --retry 3 -o /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
    && chmod 755 /usr/local/bin/yt-dlp

# Utilisateur non-root dédié. Le binaire yt-dlp est chown vers cet utilisateur
# (et non laissé root:root) car `-U` doit pouvoir se remplacer lui-même sur disque.
RUN groupadd --gid "${PGID}" ezdl \
    && useradd --uid "${PUID}" --gid "${PGID}" --create-home --shell /usr/sbin/nologin ezdl \
    && chown "${PUID}:${PGID}" /usr/local/bin/yt-dlp

WORKDIR /app

# Venv déjà résolu, copié tel quel : l'image finale ne contient ni compilateur ni
# cache uv. Le code source est copié séparément (même chemin /app que le builder,
# nécessaire car uv sync a pu créer des références relatives dans le venv).
COPY --from=builder --chown=${PUID}:${PGID} /app/.venv /app/.venv
COPY --chown=${PUID}:${PGID} . .

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

USER ezdl

EXPOSE 8000

# start-period généreux : le premier démarrage lance `yt-dlp -U` (réseau) et
# initialise la base SQLite, ce qui peut prendre du temps sur un NAS/CPU lent.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${EZDL_PORT:-8000}/api/health" || exit 1

# Forme shell + exec : substitue les variables d'env puis remplace le process shell
# (exec) pour que uvicorn reçoive directement SIGTERM et s'arrête proprement.
CMD ["sh", "-c", "exec uvicorn app.main:app --host ${EZDL_HOST:-0.0.0.0} --port ${EZDL_PORT:-8000}"]
