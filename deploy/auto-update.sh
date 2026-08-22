#!/usr/bin/env bash
# Auto-update du serveur ez-dl sur l'hôte de déploiement.
#
# À lancer régulièrement (cron ou systemd timer) depuis un clone git déployé via
# docker compose. Ne fait rien tant que EZDL_AUTO_UPDATE=true n'est pas posé dans
# le .env à la racine du clone : le flag se désactive sans toucher au cron.
#
# Comportement : fetch de la branche suivie ; si l'origin a avancé, `git pull
# --ff-only` puis rebuild du seul service `server` (`docker compose up -d --build
# server` — les services à profil, ex. cloudflared, ne sont pas touchés). Un état
# local divergent ou sale arrête le script avec une erreur explicite : ce script
# n'écrase jamais de travail local.
#
# Exemple cron (toutes les 15 minutes) :
#   */15 * * * * /chemin/du/clone/deploy/auto-update.sh >> ~/.local/state/ez-dl-update.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env"
LOCK_DIR="${REPO_DIR}/.auto-update.lock"

log() {
    printf '%s [ez-dl auto-update] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

# Lit une variable du .env sans le sourcer (un .env n'est pas un script shell :
# le sourcer exécuterait n'importe quelle ligne). Dernière occurrence gagnante.
env_value() {
    local key="$1" default="${2-}"
    local line
    line="$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -1 || true)"
    if [ -z "${line}" ]; then
        printf '%s' "${default}"
    else
        printf '%s' "${line#*=}"
    fi
}

if [ ! -f "${ENV_FILE}" ]; then
    log "aucun ${ENV_FILE} — rien à faire"
    exit 0
fi

if [ "$(env_value EZDL_AUTO_UPDATE false)" != "true" ]; then
    # Flag absent ou != true : l'auto-update est désactivé, sortie silencieuse.
    exit 0
fi

# Anti-chevauchement : un rebuild peut durer plus longtemps que l'intervalle cron.
# `mkdir` est atomique et portable (pas de dépendance à flock) ; le verrou est retiré
# à la sortie, y compris sur erreur.
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    log "une mise à jour est déjà en cours (${LOCK_DIR} présent) — abandon"
    exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

cd "${REPO_DIR}"

if [ -n "$(git status --porcelain)" ]; then
    log "ERREUR : le clone a des modifications locales — auto-update refusé"
    exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "${branch}"

local_rev="$(git rev-parse HEAD)"
remote_rev="$(git rev-parse "origin/${branch}")"
if [ "${local_rev}" = "${remote_rev}" ]; then
    # Déjà à jour : silencieux pour ne pas remplir le log à chaque tick cron.
    exit 0
fi

log "mise à jour ${local_rev:0:7} -> ${remote_rev:0:7} (${branch})"
git pull --ff-only --quiet origin "${branch}"

# EZDL_IMAGE forcé sur un nom LOCAL : `docker compose up --build` tague l'image construite
# avec la valeur `image:` du service. Sans ça, le build local prendrait le nom
# ghcr.io/corentingc/ez-dl:latest, et un `docker compose pull` ultérieur — ou watchtower —
# remplacerait silencieusement une image GPU ou à réglages maison par celle du registre.
EZDL_IMAGE=ez-dl-server:local docker compose up -d --build server

# Vérification best effort : le serveur doit répondre sur /api/health (route publique).
port="$(env_value EZDL_PORT 8000)"
for _ in 1 2 3 4 5 6; do
    sleep 5
    if curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
        log "mise à jour OK — serveur sain sur le port ${port} ($(git rev-parse --short HEAD))"
        exit 0
    fi
done

log "ERREUR : serveur muet sur /api/health après mise à jour — vérifier « docker compose logs server »"
exit 1
