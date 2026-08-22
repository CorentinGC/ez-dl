/**
 * Conteneur ICO écrit à la main.
 *
 * Le format est trivial : un en-tête ICONDIR, un ICONDIRENTRY par image, puis les images
 * concaténées. Depuis Windows Vista, une entrée peut être un PNG embarqué tel quel — les PNG
 * déjà rendus par resvg sont donc réutilisés sans réencodage. Écrire ces ~40 lignes évite
 * d'ajouter une seconde chaîne d'outils (Pillow/Python) pour empaqueter trois fichiers.
 */

const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;
const ICO_TYPE = 1;
const BITS_PER_PIXEL = 32;

/**
 * Assemble un .ico multi-résolution.
 *
 * @param {{ size: number, data: Buffer }[]} images PNG déjà rendus, une entrée par résolution.
 * @returns {Buffer} contenu binaire du fichier .ico
 */
export function buildIco(images) {
  if (images.length === 0) {
    throw new Error('buildIco : au moins une image est requise.');
  }
  for (const { size } of images) {
    // Un côté est codé sur un seul octet, 0 signifiant 256. Au-delà, le fichier serait corrompu
    // en silence : on refuse plutôt que de produire un .ico illisible.
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`buildIco : taille hors bornes ICO (1-256) : ${size}`);
    }
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(ICO_TYPE, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER_BYTES + ENTRY_BYTES * images.length;
  const directory = images.map(({ size, data }) => {
    const entry = Buffer.alloc(ENTRY_BYTES);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette : sans objet en couleurs vraies
    entry.writeUInt8(0, 3); // réservé
    entry.writeUInt16LE(1, 4); // plans
    entry.writeUInt16LE(BITS_PER_PIXEL, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...images.map((image) => image.data)]);
}
