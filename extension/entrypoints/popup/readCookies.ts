/**
 * Lecture des cookies du navigateur pour une URL donnée, sérialisés au format Netscape
 * (yt-dlp). Partagé entre `useSources` (probe authentifié) et `SourceCard` (job authentifié).
 */

import { formatNetscapeCookies } from '@/src/lib/cookies';

export async function readCookiesForUrl(url: string): Promise<string> {
  const cookies = await browser.cookies.getAll({ url });
  return formatNetscapeCookies(
    cookies.map((c) => ({
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      expirationDate: c.expirationDate,
      name: c.name,
      value: c.value,
      hostOnly: c.hostOnly,
    })),
  );
}
