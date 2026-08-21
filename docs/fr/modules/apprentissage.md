# Module — Apprentissage

Le mode apprentissage (« assisted detection ») intervient quand ni la sonde yt-dlp ni le sniffing
réseau automatique n'ont trouvé de vidéo sur la page active (voir
[modules/detection.md](detection.md)). Il transforme une intervention manuelle ponctuelle en une
règle réutilisable pour les visites suivantes du même domaine.

Suivi par l'epic beads `ez-dl-ek5`.

## Déclenchement

Dans le popup, si la fusion `/api/probe` + sniffing ne retourne aucun résultat, un bouton **« Aider
à détecter »** apparaît. Son clic déclenche le picker DOM dans l'onglet actif.

## 1. Picker DOM (`content.ts`)

Le content script (`extension/entrypoints/content.ts`) active un mode de sélection interactif sur
la page :

- **Survol** : l'élément sous le curseur est surligné (contour visuel injecté, sans modifier le DOM
  de la page de façon persistante).
- **Clic** : sélectionne l'élément — typiquement une balise `<video>`, ou un conteneur englobant le
  lecteur (iframe, div du player) si aucune balise `<video>` native n'est trouvée directement.
- L'élément sélectionné (tag, attributs pertinents comme `src`/`currentSrc`, position dans le DOM)
  est renvoyé au `background.ts` via message runtime.

## 2. Corrélation réseau (`background.ts` + `lib/correlation.ts`)

Le background script conserve un buffer glissant des requêtes réseau récentes de l'onglet (issues
du même sniffer que la détection automatique, voir
[modules/detection.md](detection.md#2-sniffing-réseau-extension)), stocké dans
`chrome.storage.session` pour survivre à un éventuel réveil du service worker.

`extension/lib/correlation.ts` croise l'élément DOM sélectionné avec ce buffer :

- correspondance directe si l'élément expose un `src`/`currentSrc` qui matche une requête récente ;
- à défaut, heuristique temporelle : requêtes vidéo/flux (mêmes patterns que le sniffer automatique)
  survenues dans une fenêtre de temps proche du chargement/de l'interaction avec l'élément
  sélectionné ;
- si plusieurs candidats subsistent, la ou les URLs les plus probables sont proposées à
  l'utilisateur pour confirmation plutôt que choisies silencieusement.

## 3. Proposition et confirmation

Le popup affiche l'URL candidate résultant de la corrélation. L'utilisateur peut :

- l'accepter telle quelle et lancer un job normalement (comme une vidéo détectée automatiquement) ;
- si le format d'URL est réutilisable pour d'autres vidéos du même site (motif générique repéré,
  ex. un chemin `/hls/{id}/index.m3u8`), enregistrer une **règle de site**.

## 4. Enregistrement de la règle (`POST /api/rules`)

```json
{"domain": "example.com", "url_pattern": "*/hls/*.m3u8", "label": "Lecteur principal", "notes": "Détecté via picker DOM le 2026-08-21", "source": "learned"}
```

`url_pattern` est un **glob/regex simple** (voir [architecture.md](../architecture.md#modèle-de-données))
appliqué par le sniffer aux futures requêtes réseau détectées sur `domain`. `source: "learned"`
distingue ces règles des règles ajoutées manuellement (`source: "manual"`, ex. via une future page
d'options avancée) dans `GET /api/rules`.

## 5. Réutilisation

Lors des visites suivantes sur le même domaine, `background.ts` charge les `SiteRule` pertinentes
(`GET /api/rules`, filtré par `domain`, mis en cache côté extension) et les applique en priorité
dans le sniffer : toute requête réseau dont l'URL matche un `url_pattern` connu est immédiatement
proposée dans le popup, sans repasser par le picker DOM. L'utilisateur peut supprimer une règle
devenue obsolète (`DELETE /api/rules/{id}`) si le site change de structure et que la règle produit
des faux positifs/négatifs.

## Points d'attention pour l'implémentation

- Le picker DOM doit être **non intrusif** : ne pas modifier le DOM final de la page de façon
  persistante (nettoyer les styles de surlignage à la désactivation du mode).
- La corrélation doit gérer l'absence de résultat clair sans planter : proposer « aucun candidat
  trouvé » plutôt qu'une URL incorrecte.
- Toute règle enregistrée passe par la validation pydantic standard de `POST /api/rules` côté
  serveur (voir [conventions.md](../conventions.md#sécurité)) — pas de contournement de la
  validation d'entrée sous prétexte que la donnée vient d'une corrélation « de confiance ».
