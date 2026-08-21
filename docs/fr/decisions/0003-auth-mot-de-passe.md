# ADR 0003 — Authentification par mot de passe partagé (Bearer)

- **Statut** : acceptée
- **Date** : 2026-08-21

## Contexte

Le serveur ez-dl est typiquement déployé sur un réseau local (NAS domestique, serveur home-lab) et
consommé par une extension Chrome. Il doit refuser tout accès non autorisé, en particulier parce
que ses routes permettent d'écrire des fichiers sur le système hôte (dans les limites de
`EZDL_DOWNLOAD_ROOTS`) et de transmettre des cookies de session de l'utilisateur. Le contexte de
déploiement (LAN personnel, un seul utilisateur ou un petit groupe de confiance, pas
d'infrastructure d'identité existante) oriente vers un mécanisme d'authentification simple à
opérer sans service tiers.

## Décision

Authentification par **mot de passe partagé transmis en Bearer token** :

- L'extension envoie `Authorization: Bearer <EZDL_PASSWORD>` sur chaque requête.
- Une dépendance FastAPI unique valide ce header sur toutes les routes sauf `GET /api/health`
  (nécessaire pour un healthcheck Docker sans configuration).
- Comparaison en **temps constant** (`secrets.compare_digest`) pour éviter les attaques par mesure
  de timing sur la comparaison de chaînes.
- Le serveur **refuse de démarrer** si `EZDL_PASSWORD` est absent ou vide — pas de mode "sans mot de
  passe" possible, même par erreur de configuration.
- Le mot de passe n'est jamais loggé, ni lui ni les cookies transmis par l'extension.
- Côté extension, le mot de passe est stocké dans `chrome.storage.local` (persistant, propre au
  profil Chrome).

## Alternatives considérées

- **Token API par client, révocable individuellement** : écarté pour la V1 — ajoute une gestion de
  cycle de vie des tokens (émission, révocation, stockage sécurisé côté serveur) disproportionnée
  pour un déploiement mono-utilisateur ou petit groupe. Réévaluable si ez-dl doit un jour gérer
  plusieurs comptes distincts.
- **mTLS (certificats client)** : écarté — complexité de génération/distribution de certificats
  côté extension Chrome (pas d'API standard pour gérer un certificat client depuis une extension
  MV3 aussi simplement qu'un mot de passe stocké), inadaptée à l'utilisateur cible (auto-hébergement
  personnel, pas nécessairement expert PKI).
- **OAuth / OpenID Connect** : écarté — suppose un fournisseur d'identité, largement disproportionné
  pour un serveur personnel sur LAN sans annuaire d'utilisateurs.
- **Pas d'authentification (réseau de confiance implicite)** : écarté — même sur un LAN, le serveur
  écrit des fichiers et manipule des cookies de session ; l'absence totale d'auth est jugée
  inacceptable, d'où la règle "refuse de démarrer sans mot de passe".

## Conséquences

- Solution simple à opérer : un seul secret à configurer côté serveur et côté extension, pas
  d'infrastructure supplémentaire.
- **Suffisant en réseau local de confiance**, mais **TLS fortement recommandé si le serveur est
  exposé au-delà du LAN** (reverse proxy avec HTTPS, ex. Caddy/Traefik) — un Bearer token en clair
  sur HTTP non chiffré est interceptable. À documenter dans `docs/fr/setup.md` et le `README.md`.
- Pas de granularité par utilisateur : tout détenteur du mot de passe a un accès complet à l'API
  (téléchargement, écriture de fichiers dans les racines autorisées, gestion des règles de site).
  Acceptable pour le cas d'usage cible (utilisateur unique ou groupe de confiance restreint).
- Si le besoin de comptes multiples ou de permissions différenciées émerge, cette ADR devra être
  révisée (migration vers des tokens par client a minima).
