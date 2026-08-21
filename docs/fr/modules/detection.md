# Module — Détection

La détection combine trois sources complémentaires : la sonde yt-dlp côté serveur, le sniffing
réseau côté extension, et les règles apprises par site. Voir aussi
[ADR 0001](../decisions/0001-stack-fastapi-wxt.md) pour le raisonnement derrière ce choix hybride.

## 1. yt-dlp probe (serveur)

`GET/POST /api/probe?url=...` (`server/app/routers/probe.py` → `server/app/services/ytdlp.py`)
appelle yt-dlp en mode extraction d'informations uniquement (pas de téléchargement), et retourne :

- métadonnées : `title`, `uploader`, `duration`, `thumbnail`, `extractor` ;
- la liste des `formats` disponibles (résolution, codecs, débit, présence audio/vidéo) ;
- `best_format_id` : le format recommandé par défaut (présélectionné côté popup) ;
- `suggested_filename` : nom de fichier dérivé du titre, déjà sanitizé.

`POST /api/probe` accepte en plus `{cookies, headers, referer}` pour les pages qui nécessitent une
session authentifiée (voir gestion des cookies dans
[conventions.md](../conventions.md#sécurité)). Les cookies sont écrits dans un fichier temporaire
`0600` passé à yt-dlp via `--cookies`, supprimé après l'appel.

Cette méthode fonctionne pour tout site couvert par un extracteur yt-dlp (liste très large,
maintenue en amont) ; elle échoue silencieusement (ou renvoie une erreur d'extraction) pour les
sites non supportés.

## 2. Sniffing réseau (extension)

`extension/entrypoints/background.ts` écoute `chrome.webRequest.onBeforeRequest` et
`onHeadersReceived` pour repérer les requêtes qui ressemblent à des flux vidéo :

- extensions d'URL : `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s` ;
- content-types de réponse : `video/*`, `application/vnd.apple.mpegurl` (HLS),
  `application/dash+xml` (DASH).

L'état détecté est conservé **par onglet** (`chrome.storage.session` — jamais en simple variable de
module, car le service worker MV3 peut être déchargé à tout moment) et **purgé à chaque
navigation** de l'onglet pour éviter de mélanger les résultats de deux pages différentes. Le badge
de l'extension affiche le nombre de flux détectés sur l'onglet actif.

`chrome.webRequest` en MV3 est **observationnel uniquement** : impossible de bloquer ou modifier la
requête depuis ce listener (contrairement à MV2). Le sniffing sert donc à *repérer* des candidats, pas
à intercepter le trafic.

## 3. Règles apprises par site (`SiteRule`)

Quand ni la sonde yt-dlp ni le sniffing ne trouvent de vidéo, l'utilisateur peut déclencher le mode
apprentissage (détaillé dans [modules/apprentissage.md](apprentissage.md)), qui aboutit à
l'enregistrement d'une `SiteRule` via `POST /api/rules` :

```json
{"domain": "example.com", "url_pattern": "*/hls/*.m3u8", "label": "Lecteur principal", "source": "learned"}
```

Lors des visites suivantes sur ce domaine, le sniffer applique en priorité les `url_pattern` connus
pour filtrer/prioriser les requêtes détectées, réduisant le bruit et évitant de repasser par le
picker DOM. `GET /api/rules` liste les règles existantes (manuelles et apprises), `DELETE
/api/rules/{id}` permet d'en retirer une devenue obsolète (ex. changement d'architecture du lecteur
vidéo côté site).

`url_pattern` accepté par `patternToRegExp` (`extension/src/lib/detection.ts`) est soit un glob
simple (seul `*` est un joker, tout le reste échappé littéralement — y compris `?`, traité comme le
séparateur de query string d'une URL et jamais comme un quantificateur regex), soit une regex brute
si le pattern contient d'autres métacaractères regex (`^ $ + ( ) { } | [ ] \`). Les règles apprises
via le picker sont enregistrées sous forme de glob généralisé automatiquement (voir
[modules/apprentissage.md](apprentissage.md#généralisation-automatique-du-pattern)) ; les règles
manuelles peuvent utiliser l'une ou l'autre syntaxe.

## Fusion des résultats côté popup

Le popup (`extension/entrypoints/popup/`) fusionne au moment de l'ouverture :

1. le résultat de `GET/POST /api/probe` sur l'URL de l'onglet actif (si l'extracteur yt-dlp
   reconnaît le site) ;
2. les flux sniffés côté `background.ts` pour cet onglet, filtrés/priorisés par les `SiteRule`
   connues pour le domaine.

Si aucune source ne remonte de résultat, le popup propose le bouton **« Aider à détecter »** qui
lance le mode apprentissage.

## Étendre la détection

- **Nouveaux patterns réseau** : ajouter l'extension/content-type dans
  `extension/lib/sniffer.ts`, avec un test Vitest associé (voir
  [conventions.md](../conventions.md#tests)).
- **Nouveaux extracteurs yt-dlp** : aucune action projet nécessaire — géré par l'auto-update yt-dlp
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`), yt-dlp doit rester le **binaire standalone** pour que `-U`
  fonctionne (voir `MEMORY.md`).
- **Site récalcitrant récurrent** : privilégier l'ajout d'une `SiteRule` (mode apprentissage) plutôt
  que du code spécifique au site dans l'extension, pour garder le sniffer générique.
