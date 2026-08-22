#!/bin/sh
# Prépare une release : réécrit les porteurs de version, promeut le CHANGELOG, vérifie, commit
# et tague. Ne pousse JAMAIS — la commande de push est affichée à la fin, à lancer à la main.
#
#   scripts/release.sh 0.2.0
#   scripts/release.sh 0.2.0 --dry-run    (n'écrit rien, montre ce qui serait fait)
#
# C'est le push du tag qui déclenche la publication (release.yml) : image GHCR en
# X.Y.Z / X.Y / latest, GitHub Release, et à terme la soumission Chrome Web Store.
set -eu

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
IS_DRY_RUN=false

log() { printf 'release: %s\n' "$*"; }
die() { printf 'release: ÉCHEC — %s\n' "$*" >&2; exit 1; }

run() {
    if [ "$IS_DRY_RUN" = true ]; then
        printf 'release: [dry-run] %s\n' "$*"
        return 0
    fi
    "$@"
}

parse_args() {
    version=""
    for arg in "$@"; do
        case "$arg" in
            --dry-run) IS_DRY_RUN=true ;;
            -*) die "option inconnue : $arg" ;;
            *) [ -z "$version" ] || die "une seule version attendue"; version="${arg#v}" ;;
        esac
    done
    [ -n "$version" ] || die "usage: release.sh X.Y.Z [--dry-run]"
    # Chrome n'accepte que des nombres dans la version du manifeste : une préversion
    # (`0.2.0-rc1`) casserait /extension/version sans le moindre message d'erreur.
    case "$version" in
        [0-9]*.[0-9]*.[0-9]*) ;;
        *) die "version '$version' attendue au format X.Y.Z, sans préversion" ;;
    esac
    case "$version" in *[!0-9.]*) die "version '$version' : chiffres et points uniquement" ;; esac
}

check_worktree() {
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
    [ "$branch" = "main" ] || die "release depuis '$branch' : se placer sur main"
    [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] \
        || die "arbre de travail sale — committer ou remiser d'abord"
    git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/v$version" >/dev/null \
        && die "le tag v$version existe déjà — un tag publié ne se déplace pas, prendre le patch suivant"
    log "branche main, arbre propre, tag v$version libre"
}

check_changelog_has_content() {
    # Publier une version dont la section est vide donne une GitHub Release sans notes et
    # un utilisateur incapable de savoir ce qui a changé. Vérifié AVANT toute écriture.
    for file in CHANGELOG.md CHANGELOG.fr.md; do
        "$REPO_ROOT/scripts/changelog-section.sh" Unreleased "$file" >/dev/null 2>&1 \
            || die "$file : la section [Unreleased] est vide — rien à publier"
    done
    log "les deux CHANGELOG ont du contenu à publier"
}

write_versions() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] écrirait $version dans server/pyproject.toml et extension/package.json"
        return 0
    fi
    REPO_ROOT="$REPO_ROOT" VERSION="$version" python3 - <<'PY'
import json, os, pathlib, re

root = pathlib.Path(os.environ["REPO_ROOT"])
version = os.environ["VERSION"]

pyproject = root / "server" / "pyproject.toml"
raw = pyproject.read_text(encoding="utf-8")
# Ancré sur la première occurrence après [project] : les dépendances contiennent
# elles aussi des numéros de version.
updated, count = re.subn(
    r'(?m)^(version\s*=\s*)"[^"]+"', rf'\g<1>"{version}"', raw, count=1
)
assert count == 1, "version introuvable dans server/pyproject.toml"
pyproject.write_text(updated, encoding="utf-8")

package = root / "extension" / "package.json"
data = json.loads(package.read_text(encoding="utf-8"))
data["version"] = version
package.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
    log "versions écrites : server/pyproject.toml, extension/package.json"
}

promote_changelog() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] promouvrait [Unreleased] en [$version] dans les deux CHANGELOG"
        return 0
    fi
    REPO_ROOT="$REPO_ROOT" VERSION="$version" RELEASE_DATE="$(date -u +%Y-%m-%d)" python3 - <<'PY'
import os, pathlib, re

root = pathlib.Path(os.environ["REPO_ROOT"])
version, date = os.environ["VERSION"], os.environ["RELEASE_DATE"]

for name in ("CHANGELOG.md", "CHANGELOG.fr.md"):
    path = root / name
    raw = path.read_text(encoding="utf-8")
    if f"## [{version}]" in raw:
        continue
    if "## [Unreleased]" not in raw:
        raise SystemExit(f"{name} : section '## [Unreleased]' introuvable")
    raw = raw.replace(
        "## [Unreleased]",
        f"## [Unreleased]\n\n## [{version}] - {date}",
        1,
    )
    # Liens de référence en bas de fichier : `Unreleased` compare depuis le nouveau tag.
    raw = re.sub(
        r"(?m)^\[Unreleased\]: (\S+)/compare/v[0-9.]+\.\.\.HEAD$",
        rf"[Unreleased]: \1/compare/v{version}...HEAD",
        raw,
    )
    previous = re.search(r"(?m)^\[([0-9.]+)\]: (\S+)/releases/tag/v[0-9.]+$", raw)
    if previous and previous.group(1) != version:
        raw = raw.replace(
            previous.group(0),
            f"[{version}]: {previous.group(2)}/releases/tag/v{version}\n{previous.group(0)}",
            1,
        )
    path.write_text(raw, encoding="utf-8")
PY
    log "CHANGELOG.md et CHANGELOG.fr.md promus en [$version]"
}

relock() {
    # Le Dockerfile fait `uv sync --frozen` : un lock désynchronisé casse le build d'image.
    run sh -c "cd '$REPO_ROOT/server' && uv lock --quiet"
    log "server/uv.lock régénéré"
}

verify() {
    if [ "$IS_DRY_RUN" = true ]; then
        log "[dry-run] lancerait check-version.sh, ruff et pytest"
        return 0
    fi
    "$REPO_ROOT/scripts/check-version.sh" "$version"
    "$REPO_ROOT/scripts/changelog-section.sh" "$version" >/dev/null
    "$REPO_ROOT/scripts/changelog-section.sh" "$version" CHANGELOG.fr.md >/dev/null
    (cd "$REPO_ROOT/server" && uv run ruff check . && uv run ruff format --check . && uv run pytest -q)
    log "vérifications vertes"
}

commit_and_tag() {
    run git -C "$REPO_ROOT" add server/pyproject.toml server/uv.lock extension/package.json \
        CHANGELOG.md CHANGELOG.fr.md
    run git -C "$REPO_ROOT" commit -m "chore(release): $version"
    run git -C "$REPO_ROOT" tag -a "v$version" -m "ez-dl $version"
    log "commit et tag v$version créés localement"
}

print_next_steps() {
    cat <<EOF

release: rien n'a été poussé. Pour publier :

    git push origin main
    git push origin v$version

Le push du TAG déclenche release.yml : image GHCR $version / ${version%.*} / latest en
amd64 + arm64, puis GitHub Release. Vérifier ensuite :

    docker buildx imagetools inspect ghcr.io/corentingc/ez-dl:$version
EOF
}

main() {
    parse_args "$@"
    check_worktree
    check_changelog_has_content
    write_versions
    promote_changelog
    relock
    verify
    commit_and_tag
    print_next_steps
}

main "$@"
