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

### Formats exposés et format recommandé

`normalize_formats` (`server/app/core/ytdlp.py`) filtre la liste brute de yt-dlp avant de
l'exposer :

- les **storyboards** (`protocol: mhtml`, planches de vignettes sans piste audio ni vidéo) sont
  retirés, ainsi que les formats **« Premium »** : ces variantes haut débit sont réservées de façon
  inconstante aux comptes YouTube Premium et peuvent échouer avec « Requested format is not
  available » — le gain de débit ne justifie pas ce risque sur le format proposé par défaut ;
- le tri place les formats **vidéo** d'abord, par résolution puis fps puis débit. Un format
  video-only n'est pas pénalisé : le sélecteur de téléchargement lui adjoint automatiquement la
  meilleure piste audio (voir [architecture.md](../architecture.md#cycle-de-vie-dun-job)) ;
- `best_format_id` est le premier de cette liste. Si le filtrage ne laisse rien, `/api/probe`
  renvoie une erreur explicite plutôt qu'une liste vide.

**YouTube exige un runtime JavaScript** (Deno, installé dans l'image Docker) : sans lui, yt-dlp ne
résout pas les challenges du player, renvoie une liste de formats amputée — voire aucun format
jouable — et `-J` échoue. `--ignore-no-formats-error` évite que cet échec devienne un 502 opaque.

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

## Bouton de téléchargement en overlay (page visitée)

Le content script ancre un bouton de téléchargement en haut à droite de **chaque** vidéo éligible
de la page, pour éviter l'aller-retour par la popup. Il n'apparaît **que si une source est
confirmée** : jamais de bouton mort. Sur une page qui liste plusieurs lecteurs, chaque bouton
télécharge *sa* vidéo (12 boutons au maximum, les plus grandes vidéos visibles).

**Conditions d'affichage**, toutes obligatoires :

1. la préférence `showPageOverlay` est active (clé `uiPrefs` de `storage.local`, section
   « Interface » de la page options — commune à tous les profils serveur) ;
2. un serveur est configuré (URL + mot de passe) ;
3. la page contient une `<video>` d'au moins **200 × 150 px** visible dans le viewport (seuils de
   `src/lib/overlayGeometry.ts`, qui écartent pubs, GIF autoplay et pixels de tracking) ;
4. le background confirme une source : une vidéo expose une URL média directe (`currentSrc` en
   `http(s)`), **ou** des flux sniffés existent pour l'onglet, **ou** le probe `/api/probe` sur
   l'URL de l'onglet renvoie au moins un format.

**Coût serveur maîtrisé** : le probe n'est déclenché qu'en dernier recours (aucun flux sniffé), une
seule fois par URL d'onglet — le résultat est mémorisé dans `TabState.quickProbe`, que la navigation
efface avec le reste de l'état d'onglet. Les iframes d'une même page partagent la requête en vol.
Quand un flux est sniffé après coup, le background pousse `OVERLAY_AVAILABLE` à l'onglet : le bouton
apparaît sans nouvelle interrogation.

**Au clic**, le job part avec les réglages par défaut du profil actif : dossier favori par défaut,
preset par défaut, cookies si l'option est active. Le média retenu suit un ordre de priorité
(`pickQuickSource`, `src/lib/quickSource.ts`) :

1. **plusieurs vidéos sur la page** → l'URL média de la vidéo cliquée : le probe ne décrit que la
   vidéo principale et téléchargerait la mauvaise ;
2. **vidéo unique** → le probe yt-dlp (meilleure qualité, pistes vidéo et audio réassemblées) ;
3. sans extracteur → l'URL média de la vidéo cliquée ;
4. à défaut → le meilleur flux sniffé (manifeste avant fichier progressif).

Le **titre** vient du DOM autour de la vidéo cliquée, et non du titre de page : attributs
`aria-label`/`title`/`data-title`, puis `h1`–`h4`, `[role="heading"]` et `figcaption`, en remontant
au plus 8 ancêtres. Le candidat plausible le plus proche gagne (`chooseVideoTitle`,
`src/lib/videoTitle.ts`), les libellés de contrôles de lecteur (« Lecture », « Play », « 0:42»…)
sont écartés, et le repli est `og:title` puis le titre de l'onglet — lu sur `sender.tab.title`,
toujours frais, là où l'instantané de page mémorisé peut dater d'avant une navigation SPA.

Les défauts communs (choix du format, nom de fichier, dossier) sont partagés avec la fiche source de
la popup : les deux chemins proposent exactement la même chose pour une même vidéo.

**Répartition des responsabilités** — le content script ne fait que du DOM et de la messagerie :

| Contexte | Rôle |
|---|---|
| `src/content/videoOverlay.ts` | suivi des `<video>`, un badge par vidéo, positionnement, toast |
| `src/content/videoTitleDom.ts` | collecte des textes candidats autour d'une vidéo |
| `src/lib/videoTitle.ts` | choix pur du titre (proximité, fiabilité, filtrage du bruit d'UI) |
| `entrypoints/background.ts` | routage `OVERLAY_CHECK` / `QUICK_DOWNLOAD`, poussée `OVERLAY_AVAILABLE` |
| `src/lib/quickDownload.ts` | probe + cache, cookies, `POST /api/jobs` |

Ni l'URL du serveur, ni le mot de passe, ni les cookies ne franchissent la frontière de la page : le
content script ne reçoit qu'un booléen de disponibilité, puis un identifiant de job ou un message
d'erreur. L'onglet et son URL viennent toujours de `sender.tab`, jamais du message. Les seules
données acceptées de la page — l'URL média et le titre de la vidéo cliquée — passent par
`sanitizeClickedVideo` : schéma `http(s)` obligatoire, longueurs bornées, titre ramené à une ligne
avant de finir dans `sanitizeFilename`.
L'UI vit dans un Shadow DOM (styles isolés dans les deux sens) et se replie pendant le mode picker.

## Détection des doublons

Avant chaque envoi — depuis la popup **comme** depuis le bouton en overlay — l'extension demande au
serveur si cette vidéo a déjà été téléchargée : `GET /api/jobs/lookup?url=…&folder=…&filename=…`.

Deux signaux, du plus explicite au plus factuel :

| Signal | `reason` | Ce qu'il attrape |
|---|---|---|
| Un job existe déjà pour cette adresse | `url` | le même lien renvoyé une seconde fois |
| Le fichier de destination existe sur le disque | `file` | une vidéo atteinte par une autre URL, ou un historique purgé |

La comparaison d'URL **ignore la query** (`scheme://host/path`, hôte en minuscules) : les liens de
CDN portent des jetons de signature, deux liens de la même vidéo diffèrent à chaque chargement de
page. Les jobs `canceled` et `error` ne comptent pas — rien n'a été livré. Un job `done` prime sur un
job plus récent encore en cours, pour que le message cite le fichier réellement présent.

**Avertissement, jamais blocage** : la route ne fait que consulter, l'appelant décide.

- **Popup** : le bouton affiche un bandeau d'avertissement et devient « Retélécharger » ; le clic
  suivant force l'envoi.
- **Bouton en overlay** : le badge passe en orange (« déjà téléchargée ») pendant 8 s ; un second
  clic dans cette fenêtre relance le job (`force: true` dans `QUICK_DOWNLOAD`).

Un serveur antérieur à cette route (404) ou injoignable ne bloque rien : l'échec de la consultation
est avalé et le téléchargement suit son cours.

## Étendre la détection

- **Nouveaux patterns réseau** : ajouter l'extension/content-type dans
  `extension/lib/sniffer.ts`, avec un test Vitest associé (voir
  [conventions.md](../conventions.md#tests)).
- **Nouveaux extracteurs yt-dlp** : aucune action projet nécessaire — géré par l'auto-update yt-dlp
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`), yt-dlp doit rester le **binaire standalone** pour que `-U`
  fonctionne (voir `MEMORY.md`).
- **Site récalcitrant récurrent** : privilégier l'ajout d'une `SiteRule` (mode apprentissage) plutôt
  que du code spécifique au site dans l'extension, pour garder le sniffer générique.
