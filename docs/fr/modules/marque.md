# Module — Marque

L'identité visuelle d'ez-dl tient en une marque unique, déclinée de l'icône 16 px de la barre
d'outils Chrome à l'aperçu social 1280×640 du dépôt. Les sources vectorielles vivent dans
`assets/`, les rendus sont générés puis **commités** à leur emplacement de consommation.

## La marque

Une flèche descendante pleine plongeant dans un bac ouvert : « télécharger vers mon stockage ».
Aucun signal « vidéo » n'est porté par le symbole — la lisibilité à 16 px prime, et le mot-clé
vidéo est déjà porté par le nom et le contexte.

Le dessin est construit sur une grille **24×24**, sur une tuile pleine page d'angle `rx=5`. Chrome
n'arrondit pas les icônes d'extension : l'arrondi fait partie du dessin.

Deux choix de construction méritent d'être connus avant toute retouche :

- **La flèche est pleine, le bac est tracé.** Un premier dessin en flèche tracée (chevron) se
  lisait comme une croix à 16 px : sous 24 px, la pointe et la hampe fusionnent. Le bac reste
  tracé parce que c'est un contenant, pas une masse.
- **Deux variantes de la même forme**, pas deux dessins. `icon.svg` sert tous les rendus ≥ 48 px ;
  `icon-small.svg` épaissit le trait du bac (2.4u → 3u) et resserre la flèche pour les rendus 16 et
  32 px, avec les bords des formes calés sur des pixels entiers de la grille 16.

## Palette

Les couleurs sont celles de l'interface, pas une palette parallèle : la marque et la popup
partagent le même accent.

| Rôle | Thème clair | Thème sombre | Variable d'interface |
|---|---|---|---|
| Tuile | `#2563eb` | `#3b82f6` | `--ez-accent` |
| Glyphe | `#ffffff` | `#0b1220` | `--ez-accent-contrast` |
| Wordmark | `#0f172a` | `#f8fafc` | — |
| Fond de l'aperçu social | `#0b1220` | idem | — |

`favicon.svg` embarque une media query `prefers-color-scheme` qui bascule la tuile ; le composant
`extension/src/components/BrandMark.tsx` s'appuie directement sur les variables CSS de la popup.

## Fichiers

Sources dans `assets/` — voir [`assets/README.md`](../../../assets/README.md) pour l'outillage :

| Fichier | Rôle |
|---|---|
| `icon.svg` | **Référence géométrique**, rendus ≥ 48 px |
| `icon-small.svg` | Variante hintée, rendus 16 et 32 px uniquement |
| `favicon.svg` | Géométrie hintée + bascule clair/sombre |
| `logo-light.svg` / `logo-dark.svg` | Lockup marque + wordmark, pour les README |
| `social-preview.svg` | Aperçu social GitHub, 1280×640 |

Rendus générés et commités :

| Fichier | Consommateur |
|---|---|
| `extension/public/icon/{16,32,48,96,128}.png` | Manifest MV3 (`icons`), généré par WXT au build |
| `server/app/static/favicon.ico` | `GET /favicon.ico`, repli multi-résolution 16/32/48 |
| `server/app/static/favicon.svg` | `GET /favicon.svg` |
| `server/app/static/apple-touch-icon.png` | `GET /apple-touch-icon.png`, écran d'accueil iOS |
| `assets/social-preview.png` | Aperçu OpenGraph du dépôt (téléversement manuel) |

`logo-*.svg` et `social-preview.svg` réembarquent les formes de `icon.svg` : un SVG doit rester
autonome pour être servi tel quel par GitHub. **`icon.svg` fait foi** ; une retouche de la
géométrie se répercute à la main dans les trois autres.

## Routes de marque du serveur

Les trois fichiers statiques sont servis par `server/app/api/brand.py`, **sans authentification**
et hors du schéma OpenAPI. La raison est mécanique : un navigateur ne joint aucun en-tête
`Authorization` à une requête de favicon, une route protégée renverrait 401 et l'onglet garderait
l'icône générique. C'est le même raisonnement que pour les routes `/extension`
([ADR 0004](../decisions/0004-distribution-extension-crx.md)).

Les chemins servis sont des constantes du paquet, jamais dérivés d'une entrée : ce module n'ouvre
aucune surface de traversée de chemin. Chaque réponse porte `Cache-Control: public, max-age=86400`.

## Régénérer

```bash
make assets
```

La cible installe les dépendances de `assets/` (isolées : ni la CI serveur ni la CI extension ne
les voient) et réécrit tous les rendus. Les PNG sont versionnés pour que le build Docker et la CI
n'aient jamais besoin de npm ni du réseau pour produire une image.

## Règles d'usage

- **Ne pas recolorer la tuile** hors des deux teintes d'accent : la marque et l'interface doivent
  rester la même couleur.
- **Ne jamais rendre `icon.svg` en dessous de 48 px** — c'est le rôle d'`icon-small.svg`.
- **Zone de respiration** : au moins la moitié de la hauteur de la tuile, libre de tout élément.
- **Ne pas éditer les PNG à la main** : le prochain `make assets` les écrase.
- **Ne pas déformer le lockup** : l'échelle est uniforme, jamais d'étirement d'un seul axe.

## Aperçu social GitHub

`assets/social-preview.png` est généré, mais son déploiement est **manuel** : aucun fichier du
dépôt ne le pilote. Le téléverser dans *Settings → General → Social preview*. À refaire après
chaque modification de `social-preview.svg`.
