# Conventions

## Style de code

- **Serveur (Python)** : suivre les règles `ruff` du projet (`server/pyproject.toml`). Typage
  systématique des signatures de fonctions. Modèles de données via SQLModel (persistance) et
  pydantic (validation d'entrée/sortie API).
- **Extension (TypeScript)** : `tsc --noEmit` strict (pas de `any` implicite). Composants React
  fonctionnels avec hooks, pas de classes. Props typées explicitement.
- **DRY / SRP** : un fichier = une responsabilité. Extraire dès qu'une fonction ou un composant
  gère plus d'une préoccupation (ex. séparer parsing de la progression yt-dlp et écriture en base).
- **Early returns** : préférer les retours anticipés à l'imbrication, maximum 3 niveaux
  d'indentation dans une fonction.
- **Pas de dead code** : supprimer le code commenté, les imports inutilisés, les branches mortes.
- **Pas de `TODO` sans issue beads** : `TODO(ez-dl-xxx): description` uniquement, jamais de `TODO`
  isolé sans référence.

## Nommage

- Identifiants et API en **anglais**, commentaires de code en **français**.
- Booléens préfixés `is`/`has`/`can`/`should` (`is_downloading`, `hasCookies`, `canRetry`,
  `shouldConvert`).
- Fichiers Python : `snake_case.py`. Fichiers TypeScript/React : `PascalCase.tsx` pour les
  composants, `camelCase.ts` pour le reste.
- Routes API : verbes HTTP + noms de ressources au pluriel (`/api/jobs`, `/api/rules`), jamais de
  verbe dans le chemin.

## Taille des fichiers

- **Warning à 400 lignes** : signal qu'un découpage doit être envisagé.
- **Découpage obligatoire au-delà de 500 lignes** : extraire en modules/sous-composants avant de
  continuer à ajouter du code dans un fichier qui dépasse ce seuil.
- Colocation : un composant React va avec ses styles et ses tests dans le même dossier ; un service
  serveur (`services/ytdlp.py`) va avec son test (`tests/test_ytdlp.py` ou équivalent).

## Tests

- **Serveur** : `pytest` + `pytest-asyncio` + `httpx` (client de test FastAPI). Couverture
  attendue :
  - **Formats** : parsing des formats renvoyés par yt-dlp, sélection du meilleur format.
  - **Capabilities** : détection des encodeurs ffmpeg disponibles, filtrage des presets.
  - **Queue** : ordonnancement, limite de concurrence (`EZDL_MAX_CONCURRENT_JOBS`), transitions
    d'état.
  - **Auth** : rejet sans `Authorization`, rejet avec mauvais mot de passe, comparaison
    constant-time, accès public à `/api/health`.
  - **Paths** : rejet des chemins hors `EZDL_DOWNLOAD_ROOTS`, résolution de `..`, sanitize des noms
    de fichiers.
- **Extension** : `Vitest`. Couverture attendue :
  - **Patterns de détection** : reconnaissance des URLs `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s` et
    des content-types vidéo.
  - **Corrélation d'apprentissage** : association d'un élément DOM sélectionné aux requêtes réseau
    récentes de l'onglet.
- Lancer les tests avant de considérer une tâche terminée : `uv run pytest` /
  `npm run test`.

## Commits

- **Conventional Commits** obligatoire : `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
  `perf:`, `style:`, `ci:`.
- Portée optionnelle entre parenthèses quand utile : `feat(server): ajoute la route /api/rules`.
- Un commit = un changement logique cohérent. Ne pas mélanger une modification de `docs/fr/` et
  `docs/en/` avec du code sans rapport.
- **Jamais de commit ou push sans validation explicite de l'utilisateur.**

## Doc bilingue

- `docs/fr/` est **canonique** : c'est la version de référence, rédigée en premier.
- `docs/en/` est un **miroir** fidèle : même structure de fichiers, même niveau de détail, contenu
  traduit (pas résumé).
- Toute modification de `docs/fr/` doit être répercutée dans `docs/en/` **dans le même commit**.
- `README.md` (racine) suit la même règle FR/EN si le projet en a deux variantes.
- L'agent `doc-maintainer` (voir `CLAUDE.md`) est responsable de la synchronisation FR↔EN.

## Sécurité

Voir le bloc dédié dans `CLAUDE.md` pour la liste complète. Rappel des points vérifiés en revue de
code (`security-reviewer`) :

- Aucun `subprocess.run(..., shell=True)` : liste d'arguments uniquement, y compris pour yt-dlp et
  ffmpeg.
- Tout chemin de destination fourni par l'utilisateur est résolu (`Path.resolve()`) et vérifié
  comme descendant d'une racine `EZDL_DOWNLOAD_ROOTS` avant toute opération d'écriture ou de
  listing (`/api/folders`).
- Noms de fichiers sanitizés : suppression de `/`, `\`, `..`, caractères de contrôle, longueur
  limitée.
- Cookies écrits dans un fichier temporaire à permissions `0600`, supprimé après le job, jamais
  loggés.
- Comparaison du mot de passe en **constant-time** (`secrets.compare_digest`).
- Toute entrée API validée par un modèle pydantic — pas de dict brut manipulé sans validation.
- Aucune information personnelle réelle dans le repo (voir `CLAUDE.md` § Projet public).
