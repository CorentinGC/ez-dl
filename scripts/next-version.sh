#!/bin/sh
# Calcule la prochaine version à partir des Conventional Commits depuis le dernier tag.
#
#   scripts/next-version.sh              -> imprime X.Y.Z, ou rien si aucune publication due
#   scripts/next-version.sh --explain    -> détaille le raisonnement sur stderr
#
# Règles (semantic-release, mode 0.x) :
#   BREAKING CHANGE / `type!:`  -> mineure  (en 0.x une rupture ne fait pas passer en 1.0)
#   feat                        -> mineure
#   fix, perf, revert           -> patch
#   docs, chore, style, test, ci, build, refactor -> aucune publication
#
# Sortie vide = rien à publier. C'est le cas nominal pour un commit de doc.
set -eu

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
IS_EXPLAIN=false
[ "${1:-}" = "--explain" ] && IS_EXPLAIN=true

explain() { [ "$IS_EXPLAIN" = true ] && printf 'next-version: %s\n' "$*" >&2 || true; }

current_version() {
    python3 - "$REPO_ROOT/server/pyproject.toml" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as stream:
    print(tomllib.load(stream)["project"]["version"])
PY
}

# Le dernier tag de version, s'il existe. `--match` évite d'attraper un tag hors versionnement.
last_tag() {
    git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true
}

# Le corps complet est nécessaire : `BREAKING CHANGE:` s'écrit dans le pied du message.
commit_range_log() {
    tag="$1"
    if [ -n "$tag" ]; then
        git -C "$REPO_ROOT" log --no-merges --format='%s%n%b%n---COMMIT---' "$tag..HEAD"
    else
        git -C "$REPO_ROOT" log --no-merges --format='%s%n%b%n---COMMIT---'
    fi
}

main() {
    tag="$(last_tag)"
    explain "dernier tag : ${tag:-aucun}"

    bump="$(commit_range_log "$tag" | awk '
        BEGIN { level = 0 }                     # 0 = rien, 1 = patch, 2 = mineure
        # Le sujet est la première ligne de chaque enregistrement.
        /^---COMMIT---$/ { is_subject = 1; next }
        NR == 1 { is_subject = 1 }
        {
            if (is_subject) {
                is_subject = 0
                # `type(scope)!: ...` ou `type!: ...` -> rupture
                if ($0 ~ /^[a-z]+(\([^)]*\))?!:/) { level = 2; next }
                if ($0 ~ /^feat(\([^)]*\))?:/)    { if (level < 2) level = 2; next }
                if ($0 ~ /^(fix|perf|revert)(\([^)]*\))?:/) { if (level < 1) level = 1; next }
                next
            }
            if ($0 ~ /^BREAKING[ -]CHANGE:/) { level = 2 }
        }
        END { print level }
    ')"

    case "$bump" in
        2) explain "rupture ou feat -> version mineure" ;;
        1) explain "fix/perf uniquement -> version patch" ;;
        *) explain "aucun commit à impact de version" ; exit 0 ;;
    esac

    version="$(current_version)"
    major="${version%%.*}"
    rest="${version#*.}"
    minor="${rest%%.*}"
    patch="${rest#*.}"
    patch="${patch%%.*}"

    # Premier tag : la version présente dans pyproject.toml est publiée telle quelle plutôt
    # que bumpée — sinon la 0.1.0 préparée à la main ne sortirait jamais.
    if [ -z "$tag" ]; then
        explain "aucun tag existant -> publication de la version courante $version"
        printf '%s\n' "$version"
        return 0
    fi

    if [ "$bump" = "2" ]; then
        minor=$((minor + 1)); patch=0
    else
        patch=$((patch + 1))
    fi
    printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

main "$@"
