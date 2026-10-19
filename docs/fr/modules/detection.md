# Module — Détection

La détection combine trois sources complémentaires : la sonde yt-dlp côté serveur, le sniffing
réseau côté extension, et les règles apprises par site. Voir aussi
[ADR 0001](../decisions/0001-stack-fastapi-wxt.md) pour le raisonnement derrière ce choix hybride,
et [ADR 0008](../decisions/0008-proxy-sortie-global-et-probe-borne.md) pour le cadrage du probe.

## 1. yt-dlp probe (serveur)

`GET/POST /api/probe` (`server/app/api/probe.py` → `server/app/core/ytdlp.py`) appelle yt-dlp en
mode extraction d'informations uniquement (pas de téléchargement), et retourne :

- métadonnées : `title`, `uploader`, `duration`, `thumbnail`, `extractor` ;
- la liste des `formats` disponibles (résolution, codecs, débit, présence audio/vidéo) ;
- `best_format_id` : le format recommandé par défaut (présélectionné côté popup) ;
- `suggested_filename` : nom de fichier dérivé du titre, déjà sanitizé.

`POST /api/probe` accepte en plus `{cookies, headers, referer}` pour les pages qui nécessitent une
session authentifiée (voir gestion des cookies dans
[conventions.md](../conventions.md#sécurité)). Les cookies sont écrits dans un fichier temporaire
`0600` passé à yt-dlp via `--cookies`, supprimé après l'appel.

Cette méthode fonctionne pour tout site couvert par un extracteur yt-dlp (liste très large,
maintenue en amont) ; elle échoue (erreur d'extraction, `502`) pour les sites non supportés.

### Règle playlist : jamais une liste entière

Le probe et le téléchargement passent par `_playlist_args` (`server/app/core/ytdlp.py`) ; `update()`
et `version()` n'extraient pas de contenu et ne sont pas concernés :

- **probe sans rang** (`playlist_items` absent) : `--no-playlist --playlist-items 1 --flat-playlist`.
  Une page de liste (recherche, chaîne, playlist, flux) est reconnue sans extraire chaque entrée
  en mémoire, et `/api/probe` répond **`422`** avec « ouvrez une vidéo » ;
- **probe avec un rang** `playlist_items=N` (entier 1–50, en query sur `GET`, dans le corps sur `POST`,
  ou sur `POST /api/jobs`) : `--no-playlist --playlist-items N`, sans `--flat-playlist`. L'entrée
  `N` est extraite complètement, formats inclus ;
- **téléchargement** : `--no-playlist --playlist-items N` (`N` = 1 sans rang), sans `--flat-playlist`.

C'est ce rang qui permet de probe la **bonne** vidéo d'un tweet à plusieurs vidéos (voir
« Sur X / Twitter » plus bas).

### Coordination des probes

`server/app/core/probe_cache.py` garde une seule instance pour tout le process :

- **2 probes** yt-dlp exécutés en même temps au maximum ;
- les appels **identiques en vol** (même URL, même rang, même contexte d'authentification) partagent
  une seule extraction. La clé ne contient qu'une empreinte SHA-256 du contexte, jamais de cookie
  en clair ;
- un succès est mis en cache **60 s** (64 entrées au maximum) ;
- quand le **dernier** demandeur part (client déconnecté, réponse `499`), la tâche est annulée et
  son groupe de process tué ;
- au-delà de `EZDL_PROBE_TIMEOUT_SECONDS` (25 s par défaut), le groupe yt-dlp est tué et la réponse
  est `502`.

Les constantes ci-dessus (2, 60 s, 64) sont des constantes de code, pas des variables `EZDL_*`.

Quand `EZDL_PROXY` est défini, le probe, le téléchargement et l'auto-update passent par ce proxy
(`--proxy`). Voir [setup.md](../setup.md#passer-par-un-vpn-ou-un-proxy).

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

La popup (`extension/entrypoints/popup/hooks/useSources.ts`) interroge le serveur **à l'ouverture**
(ou sur « Réessayer ») et jamais en arrière-plan :

1. le résultat de `GET/POST /api/probe` sur l'URL de l'onglet actif, si l'extracteur yt-dlp reconnaît
   le site. Un probe déjà fait pour cette URL par le bouton en overlay (`TabState.quickProbe`) est
   réutilisé sans nouvel appel ;
2. les flux sniffés côté `background.ts` pour cet onglet, ajoutés seulement quand le probe ne
   couvre pas la page (ou, sur X, pour étiqueter les vidéos du tweet).

Une **page de liste** (`isListingUrl`, `extension/src/lib/listingUrl.ts`) ne déclenche aucun probe :
la popup affiche « ouvrez une vidéo ». Les flux sniffés qui arrivent pendant que la popup est ouverte
sont relus sans nouveau probe.

Si aucune source ne remonte de résultat, le popup propose le bouton **« Aider à détecter »** qui
lance le mode apprentissage.

## Bouton de téléchargement en overlay (page visitée)

Le content script (`extension/src/content/videoOverlay.ts`) ancre un bouton sur **chaque** vidéo
éligible de la page, pour éviter l'aller-retour par la popup. Un bouton par vidéo, 12 au maximum
(les plus grandes vidéos visibles).

**Aucune requête serveur à l'affichage.** Le bouton apparaît dès qu'une `<video>` est éligible ; il
n'appelle ni le probe ni le serveur. Le serveur n'est sollicité qu'**au clic** : aucune requête n'est
émise en arrière-plan pour une page simplement visitée.

**Conditions d'affichage**, toutes obligatoires :

1. la préférence `showPageOverlay` est active (clé `uiPrefs` de `storage.local`, section
   « Interface » de la page options — commune à tous les profils serveur) ;
2. la `<video>` fait au moins **200 × 150 px** et est visible dans le viewport (seuils de
   `src/lib/overlayGeometry.ts`, qui écartent pubs, GIF autoplay et pixels de tracking).

**Au clic** (`QUICK_DOWNLOAD`), le service worker (`src/lib/quickDownload.ts`) vérifie la
configuration (serveur configuré, dossier favori défini) puis choisit la source. Le job part avec les
réglages par défaut du profil actif : dossier favori, preset par défaut, cookies si l'option est
active.

- **Vidéo d'un tweet** (X) : voir la section « Sur X / Twitter » ;
- **page générique** : un probe est lancé au clic, une seule fois par URL d'onglet (résultat mémorisé
  dans `TabState.quickProbe`, effacé à la navigation). Les iframes d'une même page partagent la
  requête en vol. Le média retenu suit alors cet ordre de priorité (`pickQuickSource`,
  `src/lib/quickSource.ts`) :
  1. **plusieurs vidéos sur la page** → l'URL média de la vidéo cliquée : le probe ne décrit que la
     vidéo principale et téléchargerait la mauvaise ;
  2. **vidéo unique** → le probe yt-dlp (meilleure qualité, pistes vidéo et audio réassemblées) ;
  3. sans extracteur → l'URL média de la vidéo cliquée ;
  4. à défaut → le meilleur flux sniffé (manifeste avant fichier progressif).

Si le clic ne débouche sur aucune source, le bouton passe en état d'erreur et le message est affiché
dans un toast.

**Durcissement** (commit `004153d`, `ez-dl-68t`) :

- l'overlay ignore les clics synthétiques : un événement dont `isTrusted` est faux (script de la
  page) ne déclenche rien (`src/content/videoOverlay.ts`) ;
- une URL média pointant vers un hôte privé ou de boucle (loopback, RFC 1918, link-local, ULA) est
  refusée comme source : `isPrivateHostUrl` (`src/lib/privateHost.ts`), utilisée par
  `src/lib/quickSource.ts`.

Le **titre** vient du DOM autour de la vidéo cliquée, et non du titre de page : attributs
`aria-label`/`title`/`data-title`, puis `h1`–`h4`, `[role="heading"]` et `figcaption`, en remontant
au plus 8 ancêtres. Le candidat plausible le plus proche gagne (`chooseVideoTitle`,
`src/lib/videoTitle.ts`), les libellés de contrôles de lecteur (« Lecture », « Play », « 0:42 »…)
sont écartés, et le repli est `og:title` puis le titre de l'onglet — lu sur `sender.tab.title`,
toujours frais, là où l'instantané de page mémorisé peut dater d'avant une navigation SPA.

Les défauts communs (choix du format, nom de fichier, dossier) sont partagés avec la fiche source de
la popup : les deux chemins proposent exactement la même chose pour une même vidéo.

**Positionnement.** Hors plein écran, l'hôte de l'overlay est en `position:absolute` à l'origine du
document, et chaque bouton est placé en coordonnées document : le scroll est pris en charge par le
compositeur, sans recalcul ni latence visible tant que la vidéo reste entièrement visible. En plein
écran (top layer), l'hôte passe en `position:fixed` sur l'élément plein écran.

**Répartition des responsabilités** — le content script ne fait que du DOM et de la messagerie :

| Contexte | Rôle |
|---|---|
| `src/content/videoOverlay.ts` | suivi des `<video>`, un badge par vidéo, positionnement ancré au document, toast |
| `src/content/tweetContext.ts` | contexte « tweet » d'une vidéo X (media id, permalink, rang, titre) |
| `src/content/videoTitleDom.ts` | collecte des textes candidats autour d'une vidéo |
| `src/lib/videoTitle.ts` | choix pur du titre (proximité, fiabilité, filtrage du bruit d'UI) |
| `entrypoints/background.ts` | routage de `QUICK_DOWNLOAD` vers le service worker |
| `src/lib/quickDownload.ts` | sélection de la source, probe au clic + cache, cookies, lookup, `POST /api/jobs` |
| `src/lib/tweetSource.ts` | sélection de la source d'une vidéo de tweet (pure) |

Ni l'URL du serveur, ni le mot de passe, ni les cookies ne franchissent la frontière de la page : le
content script ne reçoit qu'un résultat — identifiant de job ou message d'erreur. L'onglet et son URL
viennent toujours de `sender.tab`, jamais du message. Les seules données acceptées de la page — l'URL
média et le titre de la vidéo cliquée, plus le contexte tweet — passent par `sanitizeClickedVideo` :
schéma `http(s)` obligatoire, longueurs bornées, titre ramené à une ligne avant de finir dans
`sanitizeFilename`. L'UI vit dans un Shadow DOM (styles isolés dans les deux sens) et se replie
pendant le mode picker.

## Sur X / Twitter

Sur X, la vidéo d'un tweet ne se laisse pas identifier par son URL : `<video>.src` est un `blob:`
(lecteur MSE). Trois éléments relient l'élément du DOM au bon tweet :

- **l'identifiant de média**, présent à la fois dans l'URL du poster (`pbs.twimg.com/…/<id>/…`) et
  dans celle du flux sniffé (`video.twimg.com/…/<id>/…`) : `mediaIdFromPoster` et
  `mediaIdFromMediaUrl` (`src/lib/twitterMedia.ts`) ;
- **le permalink** du tweet, `/<user>/status/<id>` ;
- **le rang** (1-based) de la vidéo dans le tweet. Le content script le lit ; c'est
  `sanitizeClickedVideo` (`src/lib/quickSource.ts`), côté service worker, qui rejette tout rang au-delà
  de **4** (`MAX_PLAYLIST_INDEX`). Le serveur, lui, accepte jusqu'à **50** (`playlist_items`).

Le contexte est lu par `readTweetContext` (`src/content/tweetContext.ts`). Le titre prend la forme
`@handle - texte`. Une vidéo de **tweet cité** n'a pas de permalink propre : seul son media id est
retenu. Les sélecteurs `data-testid` utilisés (`User-Name`, `tweetText`) ont été vérifiés en direct ;
X peut les changer, d'où des replis : un champ manquant n'empêche pas les autres.

Au clic, `planTweetSource` (`src/lib/tweetSource.ts`) choisit une source, dans cet ordre :

1. le **meilleur flux sniffé du même média** (même media id) ;
2. sinon, un **probe du permalink** avec `playlist_items` = rang de la vidéo ;
3. sinon, l'erreur « Vidéo introuvable : ouvrez le tweet puis réessayez. ».

Règle d'or : avec un contexte de tweet, on ne retombe **jamais** sur « le plus ancien flux de
l'onglet » — sur une timeline, c'est presque toujours une autre vidéo. Le probe du permalink n'utilise
pas le cache indexé sur l'URL de l'onglet, qui décrit une autre vidéo.

`isListingUrl` (`src/lib/listingUrl.ts`) applique la même logique aux pages X : seule la page d'un tweet
(`/<user>/status/<id>`) porte une vidéo propre ; timeline, recherche et profil sont des pages de liste.

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
  `extension/entrypoints/background.ts`, avec un test Vitest associé (voir
  [conventions.md](../conventions.md#tests)).
- **Nouveaux extracteurs yt-dlp** : aucune action projet nécessaire — géré par l'auto-update yt-dlp
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`), yt-dlp doit rester le **binaire standalone** pour que `-U`
  fonctionne (voir `MEMORY.md`).
- **Site récalcitrant récurrent** : privilégier l'ajout d'une `SiteRule` (mode apprentissage) plutôt
  que du code spécifique au site dans l'extension, pour garder le sniffer générique.
