# ADR 0006 — Versionnement sémantique et canaux de publication

- **Statut** : acceptée
- **Date** : 2026-08-22
- **Amende** : [ADR 0005 — Auto-update par image GHCR + watchtower](0005-auto-update-image-ghcr-watchtower.md)

## Contexte

Le projet vise deux publics : celui qui clone le dépôt et build, et celui qui veut une commande à
copier-coller. Le second n'existait pas encore côté outillage.

Trois obstacles concrets :

- **Aucune version n'existait.** `latest` suivait chaque commit vert de `main` (ADR 0005). Un
  utilisateur qui déployait « l'image publiée » faisait donc du déploiement continu sans le
  savoir : pas de numéro à citer dans un rapport de bug, pas de retour arrière, pas de notes de
  version. Quatre porteurs de version coexistaient par ailleurs dans le dépôt
  (`server/pyproject.toml`, `APP_VERSION` recopié à la main, `extension/package.json`,
  `server/uv.lock`) sans rien pour les tenir synchronisés.
- **L'image n'était publiée qu'en amd64.** Les hôtes visés par la voie facile — NAS ARM,
  Raspberry Pi — ne pouvaient pas la tirer.
- **`PUID`/`PGID` étaient des ARG de build**, donc figés à 1000 dans l'image publiée : un hôte
  dont l'utilisateur n'est pas 1000 devait reconstruire l'image, ce qui annule tout l'intérêt
  d'une image publiée.

## Décision

### Une source de vérité pour la version

`[project].version` de `server/pyproject.toml`. C'est le seul fichier de version présent dans le
contexte de build de l'image (`context: ./server`). `APP_VERSION` le lit via `tomllib`, avec repli
`0.0.0` : un serveur qui affiche une version fausse vaut mieux qu'un serveur qui refuse de
démarrer parce qu'un fichier de packaging manque. `extension/package.json` est aligné par
`scripts/release.sh` et vérifié par `scripts/check-version.sh`.

Le format est **strictement numérique** (`X.Y.Z`) : Chrome n'accepte que 1 à 4 nombres dans le
manifeste d'une extension, et une préversion (`0.2.0-rc1`) est recopiée telle quelle dans
`extension-version.txt` par le Dockerfile, ce qui fait renvoyer `version: null` par
`/extension/version` — silencieusement. Le projet reste en `0.x` : une version mineure peut
contenir une rupture.

### C'est le tag git qui publie

`scripts/release.sh X.Y.Z` prépare tout localement (versions, `uv lock`, promotion du CHANGELOG,
lint, tests, commit, tag annoté) et **ne pousse jamais**. Le push du tag déclenche
`.github/workflows/release.yml`. Un tag publié ne se déplace jamais : une correction donne le
patch suivant.

### Canaux d'image

| Tag | Contenu | Public visé |
|---|---|---|
| `latest`, `X.Y.Z`, `X.Y` | versions taguées uniquement | déploiements, voie facile |
| `edge`, `main-<sha>` | chaque commit vert sur `main` | qui suit le dépôt |

**`latest` change donc de sens** par rapport à l'ADR 0005 : il ne suit plus `main` mais les seules
versions publiées. Un déploiement watchtower en profil `autoupdate` ne bouge plus qu'aux releases.
Qui veut le comportement précédent fixe `EZDL_IMAGE=ghcr.io/corentingc/ez-dl:edge`.

### Multi-arch sur runners natifs

`linux/amd64` + `linux/arm64`, buildés sur `ubuntu-latest` et `ubuntu-24.04-arm` (runners ARM
gratuits sur dépôt public), chacun poussant son manifeste par digest, un job `merge` assemblant
l'index avec `docker buildx imagetools create`. Pas de QEMU : `npm ci` et l'installation des
dépendances système émulés coûtent plusieurs minutes par run pour un résultat identique.

La variante GPU (`FFMPEG_VARIANT=nvenc`) reste **amd64 et build local uniquement** : le stage
`ffmpeg-nvenc` échoue volontairement hors amd64, et BuildKit l'élague quand
`FFMPEG_VARIANT=debian` — la variante publiée.

### `PUID`/`PGID` deviennent des réglages d'exécution

L'entrypoint démarre root, aligne l'utilisateur applicatif sur `PUID`/`PGID`, rend inscriptibles
`EZDL_DATA_DIR`, `EZDL_TEMP_DIR`, le cache Deno et les racines de téléchargement, puis
`exec gosu` vers cet uid. Aucune ligne applicative ne tourne en root ; `PUID=0` est refusé ; un
conteneur déjà lancé non-root (`user:` en compose) saute toute cette phase.

## Conséquences

- La voie facile devient tenable : une image versionnée, tirable anonymement, qui fonctionne sur
  un NAS ARM avec un uid quelconque.
- **Le déploiement qui suivait `latest` ne se met plus à jour à chaque commit.** C'est le but,
  mais c'est un changement de comportement pour les installations existantes : sans tag semver
  publié, elles se figent.
- Publier demande désormais un geste explicite (`release.sh` puis push du tag) et une entrée de
  CHANGELOG dans les deux langues — `release.sh` refuse une section `[Unreleased]` vide.
- La fenêtre root de l'entrypoint est un vrai changement de posture pour un projet qui était
  non-root de bout en bout. Assumée et documentée dans `SECURITY.md`.
- La CI construit deux images par run au lieu d'une. Coût absorbé par le cache `type=gha` séparé
  par arch et par la fusion des anciens jobs `docker` et `publish`, qui construisaient déjà la
  même image deux fois.

## Alternatives écartées

- **Tagger `latest` sur `main` et publier en plus des versions** : les deux canaux sur le même tag
  ne peuvent pas coexister ; c'est exactement l'ambiguïté qui rendait le déploiement imprévisible.
- **QEMU pour l'arm64** : simple à écrire, mais `npm ci` émulé rend chaque run interminable.
- **Publier la variante GPU** : elle dépend du matériel de l'hôte et ne se valide pas en CI.
- **Garder `PUID` en ARG et documenter le rebuild** : la voie facile disparaît pour tous les hôtes
  qui ne sont pas en uid 1000, c'est-à-dire la majorité des NAS.
