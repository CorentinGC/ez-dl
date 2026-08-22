[English](ROADMAP.md) | **Français**

# Feuille de route

Ce qui est prévu, à peu près dans l'ordre où ça devrait arriver. Rien ici n'est un engagement ni
une date — ez-dl est un projet self-hosted mené à côté, les priorités bougent avec l'usage réel.

Ce qui est déjà livré n'est pas listé ici : voir [CHANGELOG.fr.md](CHANGELOG.fr.md).

## Prochainement

- [ ] **Publication sur le Chrome Web Store** — installation en un clic au lieu du *Charger
  l'extension non empaquetée*. La voie auto-hébergée (`/extension/zip`, politique système) reste
  disponible quelle que soit l'issue de la revue.
- [ ] **Interface en anglais** — la popup et la page d'options sont aujourd'hui uniquement en
  français. `_locales` avec l'anglais par défaut et le français en traduction.
- [ ] **Réordonnancement de la file** — pause/reprise et retry existent déjà, déplacer un job dans
  la file non.

## Plus tard

- [ ] **Support de Firefox** — MV3 y diffère sur `webRequest` et sur la durée de vie du service
  worker : la couche de détection est à porter, pas seulement à ré-empaqueter.
- [ ] **Encodage Apple VideoToolbox** — les presets matériels existent pour NVENC, QuickSync et VAAPI.
- [ ] **Interface compagnon adaptée au mobile** — une petite UI web servie par le serveur, pour
  mettre une URL en file sans l'extension.
- [ ] **Assistant HTTPS pour le reverse proxy** — aujourd'hui le reverse proxy est documenté, pas
  assisté.

## Explicitement hors périmètre

- **Tout contournement de DRM** (Widevine, PlayReady, FairPlay). Ce n'est pas une question de
  priorité : ce ne sera pas implémenté, et ces contributions ne sont pas acceptées. Voir *Cadre
  légal* dans le [README](README.fr.md#cadre-légal).
- **Un service hébergé.** ez-dl est self-hosted par conception : aucun serveur n'est opéré par les
  auteurs, et il n'y en aura pas.

Une idée, ou besoin d'un point de « Plus tard » plus tôt ? Ouvrez une issue — voir
[CONTRIBUTING.fr.md](CONTRIBUTING.fr.md).
