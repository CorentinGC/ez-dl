/**
 * Lecture des cookies du navigateur pour une URL donnée, au format structuré `CookieParam`
 * attendu par le serveur (schéma `CookieItem` — c'est lui qui écrit le cookie-jar yt-dlp).
 *
 * Vit dans `src/lib` (et non dans la popup) parce que trois contextes en ont besoin : le probe
 * authentifié et le job de la popup, et le téléchargement en un clic déclenché par l'overlay,
 * qui s'exécute dans le service worker (un content script n'a pas accès à `browser.cookies`).
 */

import type { CookieParam } from './types';

export async function readCookiesForUrl(url: string): Promise<CookieParam[]> {
  const cookies = await browser.cookies.getAll({ url });
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expires: c.expirationDate ?? null,
  }));
}
