/**
 * Reconnaît une URL pointant vers le réseau local (loopback, RFC 1918, lien-local, ULA).
 *
 * Garde-fou SSRF : une page hostile contrôle le `src` de ses `<video>`. Sans ce filtre, une
 * URL comme `http://192.168.1.1/cgi?...` deviendrait un job exécuté par le serveur, depuis le
 * réseau du NAS. Seules les adresses littérales sont reconnues : un nom résolu en IP privée
 * reste hors de portée de l'extension.
 */

const PRIVATE_IPV4_PREFIXES: readonly [number, number, number][] = [
  // [premier octet, borne basse du second, borne haute du second]
  [0, 0, 255],
  [10, 0, 255],
  [127, 0, 255],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
  [100, 64, 127],
];

export function isPrivateHostUrl(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.startsWith('[')) return isPrivateIpv6(hostname.slice(1, -1));
  return isPrivateIpv4(hostname);
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return PRIVATE_IPV4_PREFIXES.some(([head, low, high]) => first === head && second >= low && second <= high);
}

function isPrivateIpv6(address: string): boolean {
  if (address === '::1' || address === '::') return true;
  // IPv4 mappée (`::ffff:a.b.c.d`), que `URL` normalise en hexadécimal.
  if (address.startsWith('::ffff:')) return true;
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}
