#!/bin/sh
# Génère les entrées de CHANGELOG à partir des Conventional Commits depuis le dernier tag.
#
#   scripts/changelog-entries.sh fr    -> titres en français
#   scripts/changelog-entries.sh en    -> titres en anglais
#
# Le TEXTE des entrées est le sujet des commits, donc en français dans les deux fichiers :
# seuls les titres de section sont traduits. Traduire automatiquement des messages de commit
# produirait des notes fausses ; les réécrire à la main annulerait l'intérêt de l'automatisation.
set -eu

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
lang="${1:-fr}"

case "$lang" in
    fr) H_BREAKING="Ruptures" ; H_FEAT="Ajouté" ; H_FIX="Corrigé" ; H_PERF="Performances" ;;
    en) H_BREAKING="Breaking changes" ; H_FEAT="Added" ; H_FIX="Fixed" ; H_PERF="Performance" ;;
    *) printf 'changelog-entries: langue inconnue : %s (fr|en)\n' "$lang" >&2 ; exit 1 ;;
esac

last_tag="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
range=""
[ -n "$last_tag" ] && range="$last_tag..HEAD"

# %H%x09%s : sha complet puis sujet, séparés par une tabulation — un sujet peut contenir
# n'importe quoi sauf une tabulation.
if [ -n "$range" ]; then
    log="$(git -C "$REPO_ROOT" log --no-merges --format='%H%x09%s' "$range")"
else
    log="$(git -C "$REPO_ROOT" log --no-merges --format='%H%x09%s')"
fi

breaking="$(
    if [ -n "$range" ]; then
        git -C "$REPO_ROOT" log --no-merges --format='%H%x09%s%x09%b' "$range"
    else
        git -C "$REPO_ROOT" log --no-merges --format='%H%x09%s%x09%b'
    fi | awk -F'\t' '
        $2 ~ /^[a-z]+(\([^)]*\))?!:/ || $3 ~ /BREAKING[ -]CHANGE:/ { print $1 "\t" $2 }
    '
)"

# Une entrée : `- **portée** : sujet (sha7)`, la portée retirée du sujet pour ne pas la répéter.
format_entries() {
    printf '%s\n' "$1" | awk -F'\t' '
        NF < 2 { next }
        {
            sha = substr($1, 1, 7)
            subject = $2
            scope = ""
            if (match(subject, /^[a-z]+\([^)]*\)!?: /)) {
                # RLENGTH est réécrit par le match suivant : mémoriser la longueur
                # du préfixe avant extraction de la portée (apostrophes interdites ici,
                # le programme awk est entre quotes simples).
                header_length = RLENGTH
                header = substr(subject, 1, header_length)
                if (match(header, /\([^)]*\)/)) scope = substr(header, RSTART + 1, RLENGTH - 2)
                subject = substr(subject, header_length + 1)
            } else if (match(subject, /^[a-z]+!?: /)) {
                subject = substr(subject, RLENGTH + 1)
            }
            if (scope != "") printf "- **%s** : %s (%s)\n", scope, subject, sha
            else printf "- %s (%s)\n", subject, sha
        }'
}

section() {
    title="$1" pattern="$2"
    entries="$(printf '%s\n' "$log" | grep -E "$pattern" || true)"
    [ -n "$entries" ] || return 0
    printf '### %s\n\n' "$title"
    format_entries "$entries"
    printf '\n'
}

output="$(
    if [ -n "$breaking" ]; then
        printf '### %s\n\n' "$H_BREAKING"
        format_entries "$breaking"
        printf '\n'
    fi
    section "$H_FEAT" '	feat(\([^)]*\))?!?:'
    section "$H_FIX" '	(fix|revert)(\([^)]*\))?!?:'
    section "$H_PERF" '	perf(\([^)]*\))?!?:'
)"

[ -n "$output" ] || { printf 'changelog-entries: aucun commit à publier\n' >&2 ; exit 1 ; }
printf '%s\n' "$output"
