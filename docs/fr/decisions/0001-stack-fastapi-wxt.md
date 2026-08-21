# ADR 0001 — Stack FastAPI + WXT et détection hybride

- **Statut** : acceptée
- **Date** : 2026-08-21

## Contexte

ez-dl a besoin de deux briques :

1. Un serveur qui pilote `yt-dlp` et `ffmpeg` pour télécharger et convertir des vidéos, exposant une
   API HTTP consommée par une extension de navigateur, déployable simplement (Docker, NAS
   personnel).
2. Une extension Chrome capable de détecter les vidéos présentes sur une page web, y compris les
   flux streamés (HLS/DASH) chargés dynamiquement par le lecteur de la page.

Deux questions structurantes se posent : quel langage/framework pour le serveur, et comment détecter
fiablement les vidéos côté extension.

## Décision

### Serveur : Python 3.13 + FastAPI + SQLModel, géré par uv

`yt-dlp` est un outil Python. L'exécuter comme sous-processus depuis un serveur Python (au lieu
d'un serveur Node.js qui invoquerait un binaire externe) permet :

- de rester dans un seul écosystème pour le service qui orchestre yt-dlp/ffmpeg ;
- d'utiliser FastAPI pour une API typée (pydantic), asynchrone nativement (utile pour la queue de
  jobs et le SSE via `sse-starlette`) ;
- SQLModel pour un modèle de données unique servant à la fois de schéma pydantic (validation API) et
  de table SQLite (persistance), sans dupliquer les définitions ;
- `uv` comme gestionnaire de paquets/environnement : rapide, lockfile déterministe, un seul outil
  pour venv + dépendances + exécution (`uv run`).

### Extension : WXT 0.21.4 + React + TypeScript, géré par npm

WXT fournit une structure MV3 standard (entrypoints `background`/`content`/`popup`/`options`),
le hot-reload en dev, et le build multi-navigateurs sans configuration manuelle de webpack/Vite.
React + TypeScript pour l'UI du popup et des options, cohérent avec l'écosystème front habituel.
npm est utilisé plutôt que pnpm car pnpm n'est pas installé sur la machine de développement de
référence — pas de bénéfice à introduire un outil supplémentaire pour ce projet.

### Détection hybride (yt-dlp probe + sniffing réseau + règles apprises)

Aucune méthode seule ne couvre tous les cas :

- **yt-dlp probe** (`GET /api/probe`) fonctionne très bien pour les sites supportés nativement par
  yt-dlp (des milliers d'extracteurs), mais échoue sur les sites non reconnus ou les flux générés
  dynamiquement sans URL stable.
- **Sniffing réseau** (`chrome.webRequest` côté extension) détecte les requêtes vers des flux vidéo
  (`.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s`, content-types vidéo) au moment où la page les charge,
  ce qui couvre des sites non supportés par yt-dlp — mais peut manquer une vidéo (chargement tardif,
  requêtes obfusquées) ou remonter du bruit (préchargements, publicités).
- **Règles apprises par site** (`site_rule`, mode apprentissage) capitalisent sur une session de
  détection manuelle assistée pour reconnaître automatiquement le même pattern lors des visites
  suivantes, sans repasser par le sniffing brut à chaque fois.

La combinaison des trois donne une couverture large sans dépendre d'une seule heuristique.

## Alternatives considérées

- **Serveur Node.js + wrapper CLI yt-dlp** : écarté — ajoute un langage supplémentaire pour
  orchestrer un outil déjà Python, sans bénéfice net (pas de besoin de temps réel WebSocket lourd
  que Node gérerait mieux que asyncio/SSE).
- **Extension basée uniquement sur yt-dlp probe** (pas de sniffing) : écarté — trop de sites hors du
  catalogue d'extracteurs yt-dlp resteraient non détectés, ce qui est le cas d'usage principal du
  mode apprentissage.
- **Sniffing réseau uniquement (sans yt-dlp)** : écarté — perdrait la richesse des métadonnées
  (titre, formats multiples, meilleur format) que yt-dlp extrait pour les sites supportés.
- **pnpm pour l'extension** : écarté pour l'instant, faute d'installation sur la machine de
  référence ; réévaluable si le projet grandit (workspaces multiples).

## Conséquences

- Deux écosystèmes de dépendances à maintenir (`uv`/Python, `npm`/Node), avec deux pipelines de
  lint/test distincts — documentés dans `CLAUDE.md` et `docs/fr/conventions.md`.
- La qualité de la détection dépend de la fraîcheur des extracteurs yt-dlp (d'où l'auto-update, voir
  le module [détection](../modules/detection.md)) et de la justesse des patterns de sniffing
  (`docs/fr/modules/detection.md`).
- Le mode apprentissage (ADR implicite dans [modules/apprentissage.md](../modules/apprentissage.md))
  devient un pilier du produit plutôt qu'une fonctionnalité secondaire, puisqu'il compense les
  limites structurelles des deux autres méthodes.
