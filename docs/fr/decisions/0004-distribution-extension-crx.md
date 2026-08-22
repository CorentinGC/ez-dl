# ADR 0004 — Distribution de l'extension en `.crx` signé par le serveur

- **Statut** : acceptée
- **Date** : 2026-08-22

## Contexte

Jusqu'ici, installer le client ez-dl sur une nouvelle machine imposait de refaire toute la chaîne de
développement : cloner le dépôt, installer Node, lancer `npm install`, construire l'extension, puis
la charger en « extension non empaquetée » dans `chrome://extensions`. Cette friction est
disproportionnée pour un utilisateur qui a déjà un serveur ez-dl en fonctionnement et qui veut
simplement ajouter un poste ou un profil Chrome. Elle rend aussi la mise à jour du client
manuelle et facile à oublier : rien ne signale qu'une version plus récente existe.

Le serveur, lui, est déjà le point de contact naturel de l'utilisateur : c'est l'adresse qu'il
connaît, saisit dans l'extension et ouvre dans son navigateur. Il est donc bien placé pour
distribuer le client qui lui correspond.

## Décision

Le serveur **publie l'extension empaquetée** sur quatre routes **publiques** (sans mot de passe) :

- `GET /extension` — page HTML d'installation : versions de l'extension et du serveur, bouton de
  téléchargement, trois étapes d'installation, lien secondaire vers le zip.
- `GET /extension/download` — archive `.crx` signée (`application/x-chrome-extension`, nommée
  `ez-dl-extension-<version>.crx`). `404` explicite si l'image ne contient pas l'artefact.
- `GET /extension/zip` — le zip brut, pour la voie « Charger l'extension non empaquetée »
  (développement). `404` dans les mêmes conditions.
- `GET /extension/version` — JSON `{available, version, filename, size}`. Renvoie
  `200 {"available": false, "version": null, ...}` en l'absence d'artefact — **jamais `404`** sur
  cette route, qui est consommée par la popup pour signaler une mise à jour disponible.

Le `.crx` est **signé à l'exécution par le serveur**, avec une clé RSA 2048 générée au premier
besoin dans `EZDL_DATA_DIR/extension-signing-key.pem` (permissions `0600`). Le `.crx` signé est mis
en cache dans `EZDL_DATA_DIR/extension-cache/`. L'artefact lui-même (zip + numéro de version) est
produit à la construction de l'image Docker par un stage `node:22-slim` dédié, puis copié dans
`/app/extension-dist` (`EZDL_EXTENSION_DIST_DIR`) : l'image finale ne contient aucun Node.

### Justification de l'exception d'authentification

L'ADR 0003 impose l'authentification Bearer sur **toutes** les routes sauf `GET /api/health`. Les
routes `/extension*` constituent une seconde exception, assumée pour trois raisons :

- **L'artefact ne contient que du code déjà public.** Le dépôt est source-available ; le `.crx` et
  le zip ne portent ni secret, ni donnée utilisateur, ni configuration du serveur. Les protéger ne
  protégerait rien.
- **Un lien de navigateur ne peut pas porter d'en-tête `Authorization`.** Le cas d'usage est
  précisément « ouvrir une URL et cliquer sur un bouton » : imposer un en-tête le rend impossible.
- **Un jeton en paramètre d'URL serait pire que pas de jeton.** Il fuiterait dans les journaux du
  serveur, dans ceux d'un éventuel reverse proxy et dans l'historique du navigateur — pour protéger
  un artefact qui n'a rien à protéger.

## Alternatives considérées

- **Distribuer le zip seul** : écarté comme voie principale — il impose de dézipper l'archive et de
  **conserver** le dossier extrait (Chrome charge une extension non empaquetée depuis son dossier
  source ; le supprimer casse l'extension). Le zip reste néanmoins publié sur `/extension/zip`,
  comme voie secondaire pour le développement.
- **Chrome Web Store** : écarté — compte développeur payant, revue à chaque version publiée, et
  dépendance à un tiers pour distribuer le client d'un serveur auto-hébergé, ce qui contredit la
  logique du projet.
- **Protéger les routes `/extension*` par le mot de passe** : écarté — casse le lien direct (voir
  ci-dessus) et impose de saisir un mot de passe **avant même d'avoir installé le client**, alors
  que l'artefact ne contient rien de confidentiel.
- **Signer le `.crx` à la construction de l'image Docker** : écarté — obligerait à embarquer la clé
  privée dans l'image, donc à la distribuer avec elle. La signature à l'exécution garde la clé dans
  le volume de données du déploiement.

## Conséquences

- **La clé de signature devient un état à préserver.** `EZDL_DATA_DIR` doit être monté sur un volume
  persistant (`./data:/config`) et **sauvegardé** au même titre que la base SQLite.
- **L'identifiant Chrome de l'extension dérive de cette clé.** Une clé perdue ou régénérée produit
  un nouvel identifiant : Chrome voit alors une extension **différente** et non une mise à jour de
  celle déjà installée (l'ancienne subsiste en parallèle, avec sa configuration).
- **Toute personne qui atteint le serveur peut télécharger l'extension.** Jugé acceptable : le code
  distribué est déjà public, et l'API elle-même reste protégée par le mot de passe.
- **La page `/extension` révèle l'existence d'un serveur ez-dl et sa version** à un visiteur non
  authentifié. Sans conséquence sur un LAN, mais à garder en tête pour une exposition sur Internet :
  c'est une surface d'information de plus qu'un simple `GET /api/health`.
- **Empreintes publiées pour validation.** `GET /extension/version` renvoie deux champs
  supplémentaires : `extension_id` (identifiant Chrome 32 caractères, a-p, dérivé de la clé de
  signature) et `sha256` (empreinte SHA-256 du `.crx` servi). Les deux valent `null` quand le `.crx` ne peut pas
  être préparé (dossier de données non inscriptible). La page `/extension` affiche ces deux valeurs ;
  l'utilisateur peut vérifier l'identifiant en ouvrant `chrome://extensions` après installation pour
  détecter une substitution de l'artefact en chemin.
- **Validation de la version publiée.** Le contenu de `extension-version.txt` doit être une version
  strictement numérique (`1`, `1.2`, `1.2.3` ou `1.2.3.4`) ; toute autre forme rejette le fichier,
  et le serveur retombe sur le nom générique `ez-dl-extension.crx` en annonçant `version: null`.
- **Le dossier d'artefacts est en lecture seule.** `EZDL_EXTENSION_DIST_DIR` (`/app/extension-dist`
  dans l'image) appartient à `root:root` ; le serveur, tournant sous un utilisateur non-root, ne
  peut que le lire. Motif : le serveur signe le zip qu'il y trouve avec sa clé persistante ; toute
  réécriture du zip produirait un `.crx` au même identifiant Chrome, donc une mise à jour silencieuse
  de l'extension installée, qui conserverait les permissions déjà accordées (permissions étendues :
  `<all_urls>`, `cookies`, `webRequest`).
- **Racines de téléchargement isolées.** Le serveur refuse de démarrer si une racine
  `EZDL_DOWNLOAD_ROOTS` contient (ou est contenue dans) `EZDL_DATA_DIR` ou `EZDL_EXTENSION_DIST_DIR`.
  Motif : éviter qu'un fichier téléchargé ne puisse être écrit par-dessus un artefact de
  distribution de l'extension ou la base de données. Message d'erreur explicite au démarrage.
- **Cache du `.crx` indexé sur empreinte.** Le `.crx` signé est mis en cache dans
  `EZDL_DATA_DIR/extension-cache/`, mais indexé sur le SHA-256 du zip source et non sur son
  horodatage. Un rebuild qui change le zip est donc republié même si son mtime n'a pas avancé
  (build reproductible, restauration de sauvegarde) — une invalidation sur l'horodatage servait
  sinon indéfiniment l'artefact périmé.
- Republier le client après une modification consiste à bumper `version` dans
  `extension/package.json` puis à reconstruire l'image (`docker compose up -d --build`, ou
  `make publish-extension`).
- Une image construite **sans** le contexte BuildKit `extension` (par exemple un `docker build`
  lancé à la main dans `server/`) reste valide : seule la distribution est indisponible — la page
  l'explique et les routes de téléchargement répondent `404`.

## Limite connue

Chrome n'autorise **aucune installation « en un clic »** depuis une page web hors Chrome Web Store :
le Mode développeur reste requis, et l'utilisateur doit glisser le `.crx` sur `chrome://extensions`.
L'installation et la mise à jour silencieuses via politique système (`update.xml` +
`ExtensionInstallSources` / `ExtensionInstallForcelist`) sont une évolution possible de cette
décision (issue `ez-dl-upc`) — **non implémentée à ce jour**.
