#!/bin/sh
# Installation en une commande du serveur ez-dl.
#
#   curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh | sh
#
# Ce que fait le script : télécharge le compose de la dernière release, vérifie sa somme
# SHA-256, crée le dossier de téléchargements, génère un mot de passe fort dans un .env en
# 0600, démarre le stack et attend que /api/health réponde.
#
# Réglages, tous par variables d'environnement (aucune question posée — sous `curl | sh`,
# l'entrée standard EST le script, donc `read` lirait le script lui-même) :
#
#   EZDL_DIR=~/ez-dl            dossier d'installation
#   EZDL_PORT=8000              port publié sur l'hôte
#   EZDL_DOWNLOADS_DIR=...      dossier de destination des téléchargements
#   EZDL_PASSWORD=...           mot de passe imposé (sinon généré)
#   EZDL_TAG=latest             tag d'image (`0.1.0`, `edge`…)
#   EZDL_AUTOUPDATE=true        service watchtower de mise à jour automatique
#   EZDL_IMAGE=...              image complète (prioritaire sur EZDL_TAG ; fork, image locale)
#   EZDL_RELEASE_BASE=...       base de téléchargement du compose (fork, test hors ligne)
#
#   sh install.sh --dry-run     montre ce qui serait fait, n'écrit rien
#
# Relancé sur une installation existante, il passe en mode mise à jour : il ne touche pas
# au .env (donc pas au mot de passe) et se contente de tirer et redémarrer.
set -eu

REPO="CorentinGC/ez-dl"
RELEASE_BASE="${EZDL_RELEASE_BASE:-https://github.com/${REPO}/releases/latest/download}"
COMPOSE_FILE="docker-compose.yml"

DIR="${EZDL_DIR:-$HOME/ez-dl}"
PORT="${EZDL_PORT:-8000}"
DOWNLOADS_DIR="${EZDL_DOWNLOADS_DIR:-$DIR/downloads}"
TAG="${EZDL_TAG:-latest}"
IMAGE="${EZDL_IMAGE:-ghcr.io/corentingc/ez-dl:$TAG}"
AUTOUPDATE="${EZDL_AUTOUPDATE:-true}"
IS_DRY_RUN=false
IS_UPDATE=false

log() { printf '\033[36m[ez-dl]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ez-dl]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[ez-dl] ÉCHEC\033[0m — %s\n' "$*" >&2; exit 1; }

run() {
    if [ "$IS_DRY_RUN" = true ]; then
        printf '[ez-dl] [dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

parse_args() {
    for arg in "$@"; do
        case "$arg" in
            --dry-run) IS_DRY_RUN=true ;;
            -h | --help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
            *) die "option inconnue : $arg" ;;
        esac
    done
}

require_docker() {
    command -v docker >/dev/null 2>&1 \
        || die "docker est introuvable — https://docs.docker.com/get-docker/"
    docker compose version >/dev/null 2>&1 \
        || die "le plugin 'docker compose' est introuvable (Docker >= 20.10 avec compose v2)"
    # Volontairement sans sudo : un script tiré du réseau ne doit pas demander root.
    docker info >/dev/null 2>&1 \
        || die "le démon Docker ne répond pas — le démarrer, ou ajouter votre utilisateur au groupe docker"
    log "docker et docker compose disponibles"
}

detect_mode() {
    if [ -f "$DIR/$COMPOSE_FILE" ]; then
        IS_UPDATE=true
        log "installation existante détectée dans $DIR — mode mise à jour"
    else
        log "nouvelle installation dans $DIR"
    fi
}

fetch() {
    url="$1" target="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$target"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$target" "$url"
    else
        die "ni curl ni wget — impossible de télécharger $url"
    fi
}

verify_checksum() {
    file="$1" sums="$2"
    dir="$(dirname "$file")"
    name="$(basename "$file")"
    if command -v sha256sum >/dev/null 2>&1; then
        ( cd "$dir" && sha256sum -c "$(basename "$sums")" >/dev/null ) \
            && { log "somme SHA-256 de $name vérifiée"; return 0; }
    elif command -v shasum >/dev/null 2>&1; then
        ( cd "$dir" && shasum -a 256 -c "$(basename "$sums")" >/dev/null ) \
            && { log "somme SHA-256 de $name vérifiée"; return 0; }
    else
        warn "ni sha256sum ni shasum — somme de contrôle NON vérifiée"
        return 0
    fi
    die "somme SHA-256 invalide pour $name — téléchargement corrompu ou altéré, rien n'a été installé"
}

download_compose() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] téléchargerait $RELEASE_BASE/$COMPOSE_FILE et sa somme SHA-256"
        return 0
    fi
    mkdir -p "$DIR"
    tmp="$DIR/.download"
    mkdir -p "$tmp"
    fetch "$RELEASE_BASE/$COMPOSE_FILE" "$tmp/$COMPOSE_FILE"
    if fetch "$RELEASE_BASE/$COMPOSE_FILE.sha256" "$tmp/$COMPOSE_FILE.sha256" 2>/dev/null; then
        verify_checksum "$tmp/$COMPOSE_FILE" "$tmp/$COMPOSE_FILE.sha256"
    else
        warn "somme de contrôle indisponible sur la release — fichier non vérifié"
    fi
    mv -f "$tmp/$COMPOSE_FILE" "$DIR/$COMPOSE_FILE"
    rm -rf "$tmp"
    log "compose installé dans $DIR/$COMPOSE_FILE"
}

generate_password() {
    if [ -n "${EZDL_PASSWORD:-}" ]; then
        printf '%s' "$EZDL_PASSWORD"
        return 0
    fi
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 24 | tr -d '\n=' | tr '+/' '-_'
        return 0
    fi
    LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 32
}

write_env() {
    if [ "$IS_UPDATE" = true ] && [ -f "$DIR/.env" ]; then
        log ".env existant conservé — mot de passe et réglages inchangés"
        return 0
    fi
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] écrirait $DIR/.env (0600) avec un mot de passe généré"
        return 0
    fi
    password="$(generate_password)"
    profiles=""
    [ "$AUTOUPDATE" = true ] && profiles="COMPOSE_PROFILES=autoupdate"
    # umask AVANT la redirection : le fichier ne doit jamais exister en lisible par tous,
    # même une fraction de seconde, puisqu'il contient le mot de passe du serveur.
    (
        umask 077
        cat > "$DIR/.env" <<ENV
# Généré par install.sh — contient le mot de passe du serveur, ne pas partager.
EZDL_PASSWORD=$password
EZDL_PORT=$PORT
EZDL_DOWNLOADS_DIR=$DOWNLOADS_DIR
EZDL_IMAGE=$IMAGE
PUID=$(id -u)
PGID=$(id -g)
$profiles
ENV
    )
    log ".env créé (permissions 600)"
}

prepare_downloads_dir() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] créerait $DOWNLOADS_DIR"
        return 0
    fi
    # Créé AVANT le premier `up` : un dossier de bind mount absent est créé par Docker,
    # en root, et le serveur ne peut plus y écrire.
    mkdir -p "$DOWNLOADS_DIR" || die "impossible de créer $DOWNLOADS_DIR"
    log "dossier de téléchargements : $DOWNLOADS_DIR"
}

start_stack() {
    # `pull` explicite pour que l'échec de téléchargement soit signalé ici, avec son
    # message, plutôt qu'au milieu d'un `up`. Sauté sur une image locale.
    if [ "${EZDL_PULL_POLICY:-always}" != "never" ]; then
        run sh -c "cd '$DIR' && docker compose pull --quiet"
    fi
    run sh -c "cd '$DIR' && docker compose up -d"
}

wait_for_health() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] attendrait la réponse de /api/health"
        return 0
    fi
    url="http://localhost:$PORT/api/health"
    # Jusqu'à ~2 min : le healthcheck a 60 s de start_period et le premier démarrage
    # lance une mise à jour de yt-dlp.
    attempt=0
    while [ "$attempt" -lt 60 ]; do
        if fetch "$url" /dev/null 2>/dev/null; then
            log "serveur en ligne"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    warn "le serveur n'a pas répondu sur $url après 2 minutes."
    warn "Voir les logs : cd '$DIR' && docker compose logs -f server"
    return 1
}

print_summary() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] terminé — rien n'a été écrit."
        return 0
    fi
    password_line="mot de passe inchangé (voir $DIR/.env)"
    if [ "$IS_UPDATE" = false ]; then
        password_line="mot de passe : $(grep -E '^EZDL_PASSWORD=' "$DIR/.env" | cut -d= -f2-)"
    fi
    cat <<EOF

  ez-dl est installé.

    URL         http://localhost:$PORT
    $password_line
    fichiers    $DOWNLOADS_DIR
    réglages    $DIR/.env

  Extension Chrome : ouvrir http://localhost:$PORT/extension et suivre les instructions.

  Commandes utiles :
    cd '$DIR' && docker compose logs -f server     # journaux
    cd '$DIR' && docker compose down               # arrêter
    sh install.sh                                  # mettre à jour

EOF
}

main() {
    parse_args "$@"
    require_docker
    detect_mode
    download_compose
    prepare_downloads_dir
    write_env
    start_stack
    wait_for_health || true
    print_summary
}

main "$@"
