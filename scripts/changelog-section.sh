#!/bin/sh
# Extrait le corps d'une version du CHANGELOG, pour servir de description à la GitHub Release.
#
#   scripts/changelog-section.sh 0.2.0            -> section de CHANGELOG.md
#   scripts/changelog-section.sh 0.2.0 CHANGELOG.fr.md
#
# Sort en erreur si la section est absente : une release sans note publiée vaut mieux qu'une
# release publiée avec un corps vide et personne pour s'en apercevoir.
set -eu

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

version="${1:?usage: changelog-section.sh X.Y.Z [fichier]}"
version="${version#v}"
file="${2:-CHANGELOG.md}"
case "$file" in /*) ;; *) file="$REPO_ROOT/$file" ;; esac

# awk plutôt que sed : il faut s'arrêter au titre `## ` SUIVANT, quel qu'il soit, sans
# l'imprimer. La dernière section du fichier est suivie des définitions de liens de
# référence (`[0.1.0]: https://…`) et non d'un titre : elles arrêtent aussi la capture.
section="$(awk -v version="$version" '
    $0 == "## [" version "]" || index($0, "## [" version "] ") == 1 { collecting = 1; next }
    collecting && /^## / { exit }
    collecting && /^\[[^]]+\]:[[:space:]]/ { exit }
    collecting { print }
' "$file")"

# Retire les lignes vides de tête et de queue.
section="$(printf '%s\n' "$section" | sed -e '/./,$!d' | awk '{ lines[NR] = $0 }
    END { last = NR; while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
          for (i = 1; i <= last; i++) print lines[i] }')"

if [ -z "$section" ]; then
    printf 'changelog-section: aucune section [%s] dans %s\n' "$version" "$file" >&2
    exit 1
fi

printf '%s\n' "$section"
