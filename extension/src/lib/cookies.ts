/**
 * Conversion des cookies `chrome.cookies.getAll` au format Netscape cookie-jar attendu par
 * yt-dlp (`--cookies <fichier>`). Fonction pure : la lecture réelle des cookies (`browser.cookies`)
 * reste dans la popup, seule la sérialisation est testable ici.
 */

export interface CookieLike {
  domain: string;
  path: string;
  secure: boolean;
  expirationDate?: number;
  name: string;
  value: string;
  hostOnly?: boolean;
}

/** Sérialise une liste de cookies au format Netscape (une ligne TSV par cookie). */
export function formatNetscapeCookies(cookies: CookieLike[]): string {
  const header = '# Netscape HTTP Cookie File\n';
  if (cookies.length === 0) return header;
  const lines = cookies.map((cookie) => {
    const bareDomain = cookie.domain.replace(/^\./, '');
    const domain = cookie.hostOnly ? bareDomain : `.${bareDomain}`;
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiry = cookie.expirationDate ? Math.round(cookie.expirationDate) : 0;
    return [domain, includeSubdomains, cookie.path, cookie.secure ? 'TRUE' : 'FALSE', String(expiry), cookie.name, cookie.value].join(
      '\t',
    );
  });
  return `${header}${lines.join('\n')}\n`;
}
