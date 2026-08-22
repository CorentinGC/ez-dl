#!/bin/sh
# Vérifie que tous les porteurs de version du dépôt disent la même chose.
#
# Appelé par le job `guard` de release.yml avant toute publication, et utilisable à la
# main : `scripts/check-version.sh` (vérifie la cohérence interne) ou
# `scripts/check-version.sh 0.2.0` (vérifie en plus que tout vaut bien 0.2.0).
#
# Porteurs vérifiés :
#   - server/pyproject.toml [project].version  ← SOURCE DE VÉRITÉ
#   - APP_VERSION exposé par server/app/config.py (lu depuis le pyproject, donc dérivé)
#   - extension/package.json .version          ← contrainte Chrome : 1 à 4 nombres
#   - server/uv.lock                           ← `uv sync --frozen` dans le Dockerfile
#   - CHANGELOG.md / CHANGELOG.fr.md           ← seulement s'ils existent
set -eu

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
STATUS=0

fail() {
    printf 'check-version: ÉCHEC — %s\n' "$*" >&2
    STATUS=1
}

ok() { printf 'check-version: %s\n' "$*"; }

# Version attendue : l'argument, débarrassé d'un éventuel préfixe `v` (tag git).
expected="${1:-}"
expected="${expected#v}"

read_pyproject_version() {
    python3 - "$REPO_ROOT/server/pyproject.toml" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as stream:
    print(tomllib.load(stream)["project"]["version"])
PY
}

read_package_json_version() {
    python3 - "$REPO_ROOT/extension/package.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)["version"])
PY
}

# APP_VERSION est importé depuis le paquet applicatif plutôt que grepé : c'est la valeur
# que le serveur servira réellement sur /api/health, repli `0.0.0` compris.
read_app_version() {
    (cd "$REPO_ROOT/server" && uv run --quiet python -c \
        'from app.config import APP_VERSION; print(APP_VERSION)')
}

check_changelog() {
    file="$1"
    [ -f "$file" ] || return 0
    if grep -q "^## \[${pyproject_version}\]" "$file"; then
        ok "$(basename "$file") contient la section [$pyproject_version]"
    else
        fail "$(basename "$file") n'a pas de section '## [$pyproject_version]'"
    fi
}

main() {
    pyproject_version="$(read_pyproject_version)"
    ok "source de vérité : server/pyproject.toml = $pyproject_version"

    # Chrome n'accepte que 1 à 4 entiers séparés par des points : une préversion
    # (`0.2.0-rc1`) est recopiée telle quelle dans extension-version.txt par le
    # Dockerfile et fait renvoyer `version: null` par /extension/version, sans erreur.
    case "$pyproject_version" in
        *[!0-9.]* | .* | *. | *..*)
            fail "version '$pyproject_version' non conforme au format Chrome (1 à 4 nombres)" ;;
    esac

    if [ -n "$expected" ] && [ "$expected" != "$pyproject_version" ]; then
        fail "tag $expected ≠ server/pyproject.toml $pyproject_version"
    fi

    package_version="$(read_package_json_version)"
    if [ "$package_version" = "$pyproject_version" ]; then
        ok "extension/package.json = $package_version"
    else
        fail "extension/package.json $package_version ≠ pyproject $pyproject_version"
    fi

    app_version="$(read_app_version)"
    if [ "$app_version" = "$pyproject_version" ]; then
        ok "APP_VERSION = $app_version"
    else
        fail "APP_VERSION $app_version ≠ pyproject $pyproject_version (pyproject.toml illisible ?)"
    fi

    # Sans ça, bumper pyproject.toml casse le build d'image : le Dockerfile fait
    # `uv sync --frozen`, qui refuse un lock désynchronisé.
    if (cd "$REPO_ROOT/server" && uv lock --check >/dev/null 2>&1); then
        ok "server/uv.lock à jour"
    else
        fail "server/uv.lock désynchronisé — lancer 'uv lock' dans server/"
    fi

    check_changelog "$REPO_ROOT/CHANGELOG.md"
    check_changelog "$REPO_ROOT/CHANGELOG.fr.md"

    if [ "$STATUS" -eq 0 ]; then
        ok "toutes les versions concordent"
    fi
    return "$STATUS"
}

main "$@"
