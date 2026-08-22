[English](CONTRIBUTING.md) | **Français**

# Contribuer à ez-dl

Merci d'envisager une contribution. Ce document décrit le workflow, le style de code, les
attentes en matière de tests, et quelques règles strictes sur lesquelles le projet ne transige
pas. Merci de lire également le [Code de conduite](CODE_OF_CONDUCT.md) et, pour les
vulnérabilités, [SECURITY.md](SECURITY.md).

## Workflow

1. **Forkez** le dépôt et clonez votre fork.
2. Créez une branche à partir de `main`, nommée d'après ce qu'elle fait :
   `feat/site-rule-picker`, `fix/path-traversal-check`, `docs/fr-mirror-drift`.
3. Effectuez votre modification en respectant le style de code et les règles de tests ci-dessous.
4. Committez en suivant [Conventional Commits](https://www.conventionalcommits.org/) (voir
   ci-dessous).
5. Poussez votre branche et ouvrez une pull request vers `main`. Décrivez *pourquoi* le
   changement est nécessaire, pas seulement ce qu'il fait ; liez l'issue associée le cas échéant.
6. Répondez aux retours de revue. Un mainteneur mergera une fois la PR verte et approuvée.

## Messages de commit

Utilisez [Conventional Commits](https://www.conventionalcommits.org/) :

```
feat(server): add hevc_qsv preset detection
fix(extension): stop sniffing after tab navigation
docs: sync README.fr.md with the new roadmap
refactor(server): extract path validation into its own module
test(server): cover job cancellation race
chore: bump yt-dlp pin
```

Types courants : `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`. Le scope
(`server`, `extension`, `docs`, …) est optionnel mais encouragé. Le message lui-même reste en
anglais (identifiants/API en anglais, cf. règle de style ci-dessous).

## Style de code

- **Python (`server/`) :** formaté et linté avec [ruff](https://docs.astral.sh/ruff/) — lancez
  `uv run ruff check .` (et `uv run ruff format .`) avant de pousser. Validez toutes les entrées
  externes avec des modèles pydantic. N'utilisez jamais `subprocess` avec `shell=True` ; passez
  toujours une liste d'arguments.
- **TypeScript / React (`extension/`) :** suivez les conventions WXT/React déjà en place dans le
  code. Lancez `npm run compile` pour vérifier les types avant de pousser.
- **Commentaires en français, identifiants en anglais.** Les commentaires de code (Python et
  TypeScript) sont écrits en français ; les noms de variables/fonctions/classes, les champs d'API
  et les messages de log restent en anglais. Cette règle s'applique à tout le projet, à
  l'exception de ce couple `README`/`CONTRIBUTING` de premier niveau, qui constitue une
  documentation bilingue, pas du code.
- **Fichiers de moins de ~400 lignes.** Découpez un fichier qui dépasse cette taille plutôt que de
  le laisser s'étaler.
- Hygiène générale : DRY, une seule responsabilité par module/fonction, early returns plutôt que
  des conditions imbriquées, pas de code mort ni de blocs commentés laissés traîner.

## Tests

- **Serveur :** tout nouvel endpoint, toute logique métier ou correctif nécessite un test
  `pytest` (+ `pytest-asyncio` / `httpx`). Lancez la suite avec `uv run pytest` depuis `server/`
  avant d'ouvrir une PR.
- **Extension :** la logique qui n'est pas de la simple glue d'UI (règles de sniffing,
  sanitization de nom de fichier, sélection de format, etc.) doit avoir un test
  [Vitest](https://vitest.dev/). Si Vitest n'est pas encore configuré pour la zone que vous
  touchez, ajoutez la configuration minimale avec votre changement plutôt que de sauter les
  tests.
- Une PR qui change un comportement sans test associé recevra probablement une demande d'ajout
  avant merge.

## Documentation

Ce dépôt suit deux conventions de documentation différentes — veillez à respecter la bonne :

- **`README.md` / `CONTRIBUTING.md` de premier niveau (ce fichier) et leurs équivalents
  `.fr.md` :** l'anglais est la version principale, le français est le miroir. Mettez à jour les
  deux quand vous changez un comportement utilisateur, une configuration, ou le workflow de
  contribution.
- **`docs/` :** le français y est canonique, l'anglais est le miroir (`docs/fr/…` canonique,
  `docs/en/…` synchronisé). Si votre changement affecte un comportement documenté, mettez à jour
  la source française d'abord, puis reportez le changement dans le miroir anglais dans la même
  PR.

Ne laissez pas les deux versions linguistiques diverger — une PR qui met à jour l'une sans
l'autre pourra se voir demander de compléter le miroir avant merge.

## Aucune information personnelle, aucun contournement de DRM

Chaque PR doit respecter deux règles strictes, vérifiées en revue :

- **Aucune information personnelle** où que ce soit (code, tests, doc, messages de commit,
  configuration d'exemple) : pas de véritable adresse email, de vrai nom, de vrai chemin
  NAS/serveur, de vraie adresse IP privée, ni de token/mot de passe en dur. Utilisez des
  placeholders génériques (`/mnt/media/movies`, `http://nas.local:8000`, `<your-email>`,
  `change-me-please`, …).
- **Aucun contournement de DRM.** Toute contribution qui implémenterait ou faciliterait le
  contournement de Widevine, PlayReady, FairPlay, ou de tout autre système de protection de
  contenu sera rejetée, quelle que soit sa qualité technique. Ce n'est pas négociable — voir
  [README.md > Cadre légal](README.md#legal--scope).

## Signature / attribution

En ouvrant une pull request, vous certifiez avoir écrit la contribution vous-même (ou disposer
du droit de la soumettre) et la placer sous la [LICENSE](LICENSE) du projet (PolyForm
Noncommercial 1.0.0). Merci d'ajouter une ligne de signature à vos commits :

```bash
git commit -s -m "feat(server): add hevc_qsv preset detection"
```

Cela ajoute une ligne `Signed-off-by: Votre Nom <votre@email>` au message de commit — une
attribution légère façon [Developer Certificate of Origin](https://developercertificate.org/).
Utilisez le nom/email que vous êtes à l'aise de rendre public dans l'historique git ; une adresse
`noreply` fournie par GitHub convient très bien.

## Ajouter un preset de conversion

Les presets sont déclarés côté serveur et exposés via `/api/capabilities` uniquement quand
l'encodeur `ffmpeg` correspondant est réellement disponible (détecté au démarrage via
`ffmpeg -encoders`). Pour en ajouter un :

1. Ajoutez la définition du preset (id, label, description, conteneur, codec vidéo, arguments
   ffmpeg) dans le registre de presets du serveur.
2. Conditionnez-le à la présence de l'encodeur correspondant — ne supposez jamais qu'un encodeur
   existe uniquement parce que le preset est défini.
3. Vérifiez qu'il apparaît bien dans `GET /api/capabilities` une fois l'encodeur disponible
   localement (ou mocké dans un test).
4. Ajoutez un test couvrant les deux cas "encodeur présent" et "encodeur absent".
5. S'il est visible côté utilisateur (ex. un nouveau backend matériel), mentionnez-le dans
   `README.md` / `README.fr.md`.

## Ajouter une règle de détection de site

Les règles de site (`domain`, `url_pattern`, `label`, `notes`, `source`) indiquent au sniffer de
l'extension comment reconnaître un flux vidéo sur un domaine donné. Elles peuvent être créées de
deux façons :

- **Apprises à l'exécution** par un utilisateur, via le sélecteur "Aider à détecter" →
  `POST /api/rules` avec `source: "learned"`. Aucun changement de code nécessaire ; c'est le
  chemin normal côté utilisateur final.
- **Livrées comme règle par défaut**, avec `source: "manual"`, quand un site est assez répandu
  pour justifier une détection prête à l'emploi sans que chaque utilisateur ait à l'apprendre
  individuellement.

Si vous contribuez une règle intégrée : ajoutez-la à l'ensemble de règles par défaut de
l'extension, gardez `url_pattern` comme un glob/regex simple (pas de logique métier spécifique au
site greffée dessus), et incluez une courte note sur comment vous l'avez vérifiée (quelle(s)
page(s), quel motif d'URL de flux elle capture).

## Versions et publication

Une seule source de vérité pour le numéro de version : `[project].version` de
`server/pyproject.toml`. `APP_VERSION` en est dérivé (lecture `tomllib`), et
`extension/package.json` doit être aligné dessus.

Format **strictement numérique** (`X.Y.Z`, 1 à 4 nombres) : Chrome refuse toute autre forme
dans le manifeste d'une extension, et une préversion comme `0.2.0-rc1` fait renvoyer
`version: null` par `/extension/version`, sans erreur visible.

**Publier est automatique** : rien à lancer. À chaque push vert sur `main`, la CI lit les
Conventional Commits depuis le dernier tag et publie si nécessaire.

| Ce que vous écrivez | Ce que ça publie |
|---|---|
| `feat: …` ou une rupture (`type!:`, `BREAKING CHANGE:` en pied) | version **mineure** |
| `fix: …`, `perf: …`, `revert: …` | version **patch** |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `style:` | rien (canal `edge` seulement) |

Le **type de commit est donc un acte de publication** : un `feat:` poussé sur `main` sort une
version, image GHCR et GitHub Release comprises. Un travail qui ne doit pas déclencher de version
se commite en `refactor:` ou `chore:`.

Les entrées de CHANGELOG sont générées depuis les sujets de commits — d'où l'importance d'un sujet
lisible par un utilisateur, pas par un mainteneur. Ce qui est écrit à la main sous
`## [Unreleased]` est conservé au-dessus des entrées générées.

Vérifier ou publier à la main reste possible :

```bash
scripts/check-version.sh            # cohérence pyproject / APP_VERSION / package.json / uv.lock
scripts/next-version.sh --explain   # ce que la CI publierait maintenant, et pourquoi
scripts/release.sh 0.2.0 --dry-run  # ce qui serait fait, sans rien écrire
scripts/release.sh 0.2.0            # release hors bande : commit + tag locaux, aucun push
```

Canaux d'image publiés :

| Tag | Contenu |
|---|---|
| `latest`, `X.Y.Z`, `X.Y` | versions taguées uniquement |
| `edge`, `main-<sha>` | chaque commit vert sur `main` |

Un tag publié ne se déplace jamais : une correction donne le patch suivant.

## Checklist de PR

- [ ] Le code respecte les règles de style ci-dessus (ruff propre / `npm run compile` propre)
- [ ] Tests ajoutés/mis à jour et passants (`uv run pytest`, et Vitest le cas échéant)
- [ ] `README`/`README.fr.md` et/ou `docs/` mis à jour si le comportement ou la configuration ont
      changé
- [ ] Le type de commit correspond à l'intention (`feat:`/`fix:` publient une version,
      `chore:`/`refactor:` non)
- [ ] Aucune information personnelle, aucun code de contournement de DRM
- [ ] Les commits suivent Conventional Commits et sont signés (`-s`)
