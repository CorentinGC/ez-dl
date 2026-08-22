/**
 * Rendu des assets de marque ez-dl : SVG maîtres de ce dossier vers les PNG et ICO servis par
 * l'extension et par le serveur.
 *
 * Les sorties sont écrites à leur emplacement définitif et COMMITÉES : ni le build Docker ni la
 * CI ne doivent avoir besoin de npm ou du réseau pour produire une image. Ce script ne se relance
 * qu'après modification d'un SVG (`make assets` depuis la racine du dépôt).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { buildIco } from './ico.mjs';

const ASSETS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(ASSETS_DIR, '..');

// 16 et 32 px viennent de la variante hintée : à cette taille le stroke fin du master devient un
// gris flou. Voir le commentaire en tête de icon-small.svg.
const EXTENSION_ICONS = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 96, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
];

// Un favicon .ico embarque plusieurs résolutions : le navigateur choisit la plus proche de son
// besoin (onglet, favori, raccourci bureau) plutôt que de rééchantillonner une seule image.
const FAVICON_ICO_SIZES = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon.svg' },
];

const APPLE_TOUCH_ICON_PX = 180;
const SOCIAL_PREVIEW_PX = 1280;

/** Rastérise un SVG de ce dossier à la largeur demandée. */
function rasterize(source, width) {
  const svg = readFileSync(join(ASSETS_DIR, source), 'utf8');
  const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  return renderer.render().asPng();
}

/** Écrit un fichier en créant son dossier parent au besoin. */
function write(target, data) {
  const absolute = join(REPO_DIR, target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, data);
  console.log(`  ${target} (${data.length} o)`);
}

function renderExtensionIcons() {
  console.log("Icônes de l'extension Chrome :");
  for (const { size, source } of EXTENSION_ICONS) {
    write(`extension/public/icon/${size}.png`, rasterize(source, size));
  }
}

function renderServerStatics() {
  console.log('Assets statiques du serveur :');
  const ico = buildIco(
    FAVICON_ICO_SIZES.map(({ size, source }) => ({ size, data: rasterize(source, size) })),
  );
  write('server/app/static/favicon.ico', ico);
  write('server/app/static/apple-touch-icon.png', rasterize('icon.svg', APPLE_TOUCH_ICON_PX));

  // Le favicon vectoriel est servi tel quel : sa media query prefers-color-scheme doit survivre.
  const faviconSvg = join(REPO_DIR, 'server/app/static/favicon.svg');
  mkdirSync(dirname(faviconSvg), { recursive: true });
  copyFileSync(join(ASSETS_DIR, 'favicon.svg'), faviconSvg);
  console.log('  server/app/static/favicon.svg (copie)');
}

function renderSocialPreview() {
  console.log('Aperçu social GitHub :');
  write('assets/social-preview.png', rasterize('social-preview.svg', SOCIAL_PREVIEW_PX));
}

renderExtensionIcons();
renderServerStatics();
renderSocialPreview();
console.log('\nRendu terminé. Pensez à commiter les fichiers générés.');
