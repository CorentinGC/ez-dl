# Assets de marque ez-dl

Sources vectorielles de l'identité visuelle et chaîne de rendu vers les formats consommés par
l'extension Chrome et par le serveur.

La documentation d'usage (palette, tailles, règles) vit dans
[`docs/fr/modules/marque.md`](../docs/fr/modules/marque.md). Ce fichier ne couvre que l'outillage.

## Sources

| Fichier | Rôle |
|---|---|
| `icon.svg` | **Référence géométrique.** Marque sur grille 24, tuile pleine page. Sert à tous les rendus ≥ 48 px. |
| `icon-small.svg` | Même marque, épaissie et recalée sur la grille pixel. **Uniquement** pour 16 et 32 px. |
| `favicon.svg` | Géométrie hintée + media query `prefers-color-scheme` sur la tuile. |
| `logo-light.svg` / `logo-dark.svg` | Lockup marque + wordmark, pour les README GitHub. |
| `social-preview.svg` | Aperçu social GitHub, 1280×640. |

`logo-*.svg` et `social-preview.svg` **réembarquent** les formes de `icon.svg` : un SVG doit rester
autonome pour être servi directement par GitHub. Toute retouche de la géométrie se répercute donc
dans quatre fichiers — `icon.svg` fait foi.

## Régénérer

```bash
make assets          # depuis la racine du dépôt
# ou
cd assets && npm install && npm run render
```

Sorties écrites à leur emplacement définitif, et **commitées** :

```
extension/public/icon/{16,32,48,96,128}.png
server/app/static/{favicon.ico,favicon.svg,apple-touch-icon.png}
assets/social-preview.png
```

Elles sont versionnées parce que ni le build Docker ni la CI ne doivent dépendre de npm ou du
réseau pour produire une image. Le dossier `assets/` a son propre `package.json` : il n'est installé
ni par la CI du serveur ni par celle de l'extension.

## Pièges

- **`@resvg/resvg-js` embarque un binaire précompilé** — aucune dépendance système (ni cairo ni
  librsvg n'est requis).
- **Les wordmarks utilisent une police système**, verrouillée en largeur par `textLength`. Le rendu
  de `social-preview.png` reflète donc la police de la machine qui lance `make assets` ; c'est sans
  conséquence tant que la pile de repli reste une grotesque neutre.
- **Ne pas éditer les PNG à la main** : le prochain `make assets` les écrase.
- **`social-preview.png` ne se déploie pas tout seul** : il faut le téléverser dans
  *Settings → General → Social preview* du dépôt GitHub.
