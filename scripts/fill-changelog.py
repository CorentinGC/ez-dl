"""Insère sous `## [Unreleased]` les entrées générées depuis les Conventional Commits.

Appelé par `scripts/release.sh --auto` avec FR_ENTRIES / EN_ENTRIES dans l'environnement.
Fichier séparé plutôt qu'un heredoc : le script shell contient déjà des heredocs Python,
et les imbriquer rend le tout illisible autant que fragile.
"""

import os
import pathlib

root = pathlib.Path(os.environ["REPO_ROOT"])
MARKER = "## [Unreleased]"

for name, key in (("CHANGELOG.md", "EN_ENTRIES"), ("CHANGELOG.fr.md", "FR_ENTRIES")):
    path = root / name
    raw = path.read_text(encoding="utf-8")
    if MARKER not in raw:
        raise SystemExit(f"{name} : section '{MARKER}' introuvable")
    entries = os.environ[key].strip()
    head, _, tail = raw.partition(MARKER)
    # Ce qui avait été écrit à la main sous [Unreleased] est conservé, au-dessus des
    # entrées générées : un texte rédigé exprès ne doit jamais être perdu.
    path.write_text(f"{head}{MARKER}\n\n{entries}\n{tail.lstrip(chr(10))}", encoding="utf-8")
