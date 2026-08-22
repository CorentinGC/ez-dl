#!/bin/sh
#
# Entrypoint du serveur ez-dl.
#
# Rôle unique : rendre inscriptibles, au démarrage, les chemins que le serveur doit
# écrire — puis abandonner les privilèges avant d'exécuter la moindre ligne applicative.
#
# Pourquoi le conteneur démarre root
# ----------------------------------
# PUID/PGID étaient jusqu'ici des ARG de BUILD, donc figés à 1000 dans l'image publiée.
# Sur un NAS ou un Raspberry Pi dont l'utilisateur n'est pas uid 1000, ni /config ni les
# racines de téléchargement montées en bind ne sont inscriptibles : le serveur ne peut ni
# ouvrir sa base SQLite ni sauver un fichier. Seul root peut corriger ces propriétaires.
# On démarre donc root, on corrige, et on repasse immédiatement à l'utilisateur applicatif
# via gosu : AUCUN code applicatif ne s'exécute en root.
#
# Si le conteneur est déjà lancé non-root (`user:` dans compose, `docker run --user`), ce
# script ne peut rien chown et n'essaie pas : il exécute directement la commande reçue.
# C'est le comportement historique de l'image, préservé tel quel.
#
set -eu

APP_USER=ezdl

log() { printf '[ez-dl] %s\n' "$*"; }
warn() { printf '[ez-dl] ATTENTION : %s\n' "$*" >&2; }

# --- Résolution des identifiants ---------------------------------------------------
#
# Défaut = l'utilisateur applicatif tel que l'image l'a créé, et NON 1000 en dur : une
# image buildée avec `--build-arg PUID=…` doit continuer à fonctionner sans que
# l'utilisateur ait à repositionner la variable d'environnement.
resolve_ids() {
    target_uid="${PUID:-$(id -u "$APP_USER")}"
    target_gid="${PGID:-$(id -g "$APP_USER")}"

    case "$target_uid$target_gid" in
        *[!0-9]*)
            warn "PUID/PGID doivent être numériques (reçu PUID=$target_uid PGID=$target_gid) ; valeurs de l'image conservées."
            target_uid="$(id -u "$APP_USER")"
            target_gid="$(id -g "$APP_USER")"
            ;;
    esac

    # Refus explicite plutôt que silence : PUID=0 ferait tourner tout le serveur — donc
    # les subprocess yt-dlp et ffmpeg, qui manipulent des entrées distantes — en root.
    if [ "$target_uid" = "0" ]; then
        warn "PUID=0 refusé : le serveur ne doit pas s'exécuter en root."
        warn "Utilisez PUID/PGID pour aligner l'utilisateur du conteneur sur le propriétaire de vos volumes."
        exit 1
    fi
}

# --- Alignement de l'entrée passwd -------------------------------------------------
#
# gosu sait prendre un couple numérique sans entrée passwd, mais Python et certaines
# librairies appellent pwd.getpwuid() et lèvent une KeyError sur un uid inconnu. On
# réaligne donc l'utilisateur de l'image plutôt que de simplement changer de numéro.
# -o (non unique) : un GID comme 100 (`users`) existe déjà sur Debian, et c'est
# précisément un GID courant sur les NAS.
align_app_user() {
    current_uid="$(id -u "$APP_USER")"
    current_gid="$(id -g "$APP_USER")"

    [ "$current_gid" = "$target_gid" ] || groupmod -o -g "$target_gid" "$APP_USER"
    [ "$current_uid" = "$target_uid" ] || usermod -o -u "$target_uid" "$APP_USER"

    if [ "$current_uid" != "$target_uid" ] || [ "$current_gid" != "$target_gid" ]; then
        log "utilisateur applicatif aligné sur ${target_uid}:${target_gid}"
        # Le binaire yt-dlp doit rester inscriptible par l'utilisateur applicatif :
        # `yt-dlp -U` se remplace lui-même sur disque (EZDL_YTDLP_UPDATE_INTERVAL_HOURS).
        chown "${target_uid}:${target_gid}" /usr/local/bin/yt-dlp 2>/dev/null || true
    fi
}

# --- Chemins possédés par le serveur -----------------------------------------------
#
# Récursif, et c'est voulu : ces dossiers sont créés et remplis par ez-dl seul, ils sont
# petits (base SQLite, clé de signature, cache Deno, jobs en cours).
own_recursively() {
    dir="$1"
    [ -n "$dir" ] || return 0
    mkdir -p "$dir" 2>/dev/null || true
    if [ -d "$dir" ]; then
        chown -R "${target_uid}:${target_gid}" "$dir" 2>/dev/null \
            || warn "impossible de changer le propriétaire de $dir — le serveur risque de ne pas pouvoir y écrire."
    fi
}

# --- Racines de téléchargement -----------------------------------------------------
#
# NON récursif, et c'est un choix de sécurité autant que de performance : une racine
# pointe typiquement sur une bibliothèque média de plusieurs téraoctets, déjà possédée
# par l'utilisateur de l'hôte. Un `chown -R` la réécrirait entièrement, prendrait des
# heures et casserait les droits d'autres applications partageant ce partage.
#
# On ne touche au propriétaire que si le dossier n'est PAS déjà inscriptible par
# l'utilisateur cible : un partage NFS/SMB monté avec les bons droits reste intact.
own_download_roots() {
    raw="${EZDL_DOWNLOAD_ROOTS:-Downloads=/data/downloads}"

    # Découpage sur la virgule via tr : un chemin peut contenir des espaces, ce qui
    # exclut de s'appuyer sur le découpage de mots du shell.
    #
    # `printf '%s\n'` et non `printf '%s'` : sans saut de ligne final, `read` renvoie faux
    # sur la dernière ligne — donc sur la ligne unique du cas par défaut — et le corps de
    # boucle n'est jamais exécuté.
    printf '%s\n' "$raw" | tr ',' '\n' | while IFS= read -r chunk; do
        case "$chunk" in
            *=*) ;;
            *) continue ;;
        esac

        path="${chunk#*=}"
        # Trim des espaces autour du chemin, comme le fait parse_download_roots().
        path="$(printf '%s' "$path" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

        # `/` est refusé par la configuration elle-même : ne rien tenter ici non plus.
        [ -n "$path" ] && [ "$path" != "/" ] || continue

        if [ ! -d "$path" ]; then
            mkdir -p "$path" 2>/dev/null \
                || { warn "racine de téléchargement absente et non créable : $path"; continue; }
            log "racine de téléchargement créée : $path"
        fi

        if gosu "${target_uid}:${target_gid}" test -w "$path"; then
            continue
        fi

        chown "${target_uid}:${target_gid}" "$path" 2>/dev/null \
            || warn "racine $path non inscriptible par ${target_uid}:${target_gid} et chown refusé — les téléchargements y échoueront."
    done
}

main() {
    # Conteneur déjà lancé non-root : aucun privilège pour corriger quoi que ce soit,
    # l'utilisateur a pris la main sur les droits. On n'ajoute pas de bruit.
    if [ "$(id -u)" != "0" ]; then
        exec "$@"
    fi

    resolve_ids
    align_app_user

    own_recursively "${EZDL_DATA_DIR:-/config}"
    own_recursively "${EZDL_TEMP_DIR:-/tmp/ez-dl}"
    own_recursively "${HOME:-/home/ezdl}/.cache"
    own_download_roots

    exec gosu "${target_uid}:${target_gid}" "$@"
}

main "$@"
