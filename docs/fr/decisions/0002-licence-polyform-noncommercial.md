# ADR 0002 — Licence PolyForm Noncommercial 1.0.0

- **Statut** : acceptée
- **Date** : 2026-08-21

## Contexte

ez-dl est un repo public, source-available. Le besoin métier est double :

- Rendre le code source **librement utilisable, modifiable et redistribuable pour un usage non
  commercial** (auto-hébergement personnel, contributions communautaires, forks non commerciaux).
- Se réserver la possibilité de proposer une **licence commerciale payante** à toute entité qui
  voudrait exploiter ez-dl (ou un dérivé) dans un cadre commercial — par exemple un service hébergé
  facturé, ou une intégration dans un produit commercial.

Ce besoin exclut d'office les licences open source classiques approuvées par l'OSI (MIT, Apache
2.0, GPL...), qui autorisent toutes l'usage commercial sans distinction.

## Décision

Adopter **PolyForm Noncommercial 1.0.0** :

- Usage, modification et distribution libres pour tout usage **non commercial**.
- Usage commercial interdit sous cette licence ; nécessite un accord de licence commerciale séparé
  (contact via GitHub Issues ou l'adresse placeholder `<contact@example.com>` — voir `README.md`).
- Licence courte, standardisée (famille PolyForm), largement reconnue dans l'écosystème
  source-available, ce qui limite le besoin de rédiger des CGU sur mesure.

## Alternatives considérées

- **AGPL v3 + double licence commerciale** : écarté — l'AGPL reste une licence open source qui
  autorise l'usage commercial (y compris via un service réseau, avec l'obligation de publier les
  modifications), ce qui ne correspond pas au besoin de réserver strictement l'usage commercial à
  une licence payante. La double licence AGPL/commerciale est un modèle courant, mais elle n'empêche
  pas un usage commercial du code sous AGPL lui-même (à condition de publier les sources), ce qui
  affaiblit la valeur de la licence commerciale.
- **BUSL (Business Source License)** : écarté — modèle plus complexe (licence à bascule vers une
  licence open source après une période donnée, "Additional Use Grant" à définir précisément), plus
  adapté à des produits avec une feuille de route de licensing élaborée. Complexité non justifiée
  pour un projet greenfield.
- **Licence propriétaire fermée (pas de source-available)** : écarté — contraire à l'objectif de
  transparence du projet (le README doit notamment expliciter l'absence de contournement DRM et les
  permissions de l'extension) et à l'intérêt d'accepter des contributions communautaires.

## Conséquences

- **Non approuvée par l'OSI** : ez-dl ne peut pas se présenter comme "open source" au sens strict
  (OSI-approved), seulement comme "source-available". À mentionner explicitement dans le `README.md`
  pour éviter toute ambiguïté auprès des utilisateurs et contributeurs.
- Les contributions externes acceptent implicitement les termes de la licence pour leur code
  contribué ; à clarifier dans `CONTRIBUTING.md` si des contributions tierces sont attendues.
- Toute demande d'usage commercial doit être redirigée vers le canal de contact indiqué dans le
  `README.md` (issues GitHub ou email placeholder — jamais une adresse email personnelle réelle dans
  le repo, voir `CLAUDE.md` § Projet public).
- Le fichier `LICENSE` à la racine contient le texte PolyForm Noncommercial 1.0.0 avec la mention
  `Required Notice: Copyright ez-dl contributors` (pas de nom de personne physique).
