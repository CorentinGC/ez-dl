/**
 * Lecture des cookies du navigateur pour une URL donnée, au format structuré `CookieParam`
 * attendu par le serveur (schéma `CookieItem` — c'est lui qui écrit le cookie-jar yt-dlp).
 * Partagé entre `useSources` (probe authentifié) et `SourceCard` (job authentifié).
 */

import type { CookieParam } from '@/src/lib/types';

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
