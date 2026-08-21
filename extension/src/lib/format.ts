/**
 * Formatage lisible de tailles, débits, durées et progression — utilisé par la popup (fiches
 * source et suivi des jobs). Fonctions pures, décimales en virgule (convention FR).
 *
 * Contrat serveur (`/api/jobs`, voir `types.ts`) : `speed` en octets/s, `eta` en secondes,
 * `size` en octets, `progress` en pourcentage 0.0–100.0.
 */

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Exposant d'unité (0 = octets, 1 = Ko, ...) pour une quantité d'octets strictement positive. */
function unitExponent(bytes: number): number {
  return Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
}

/**
 * Formate une quantité déjà ramenée à son unité : entier si >= 10 ou en octets bruts (exposant 0),
 * sinon une décimale avec virgule (convention FR) pour rester compact et lisible.
 */
function formatQuantity(value: number, exponent: number): string {
  const unit = UNITS[exponent] ?? 'o';
  const useDecimal = exponent > 0 && value < 10;
  const rounded = useDecimal ? Math.round(value * 10) / 10 : Math.round(value);
  const options = useDecimal ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : undefined;
  return `${rounded.toLocaleString('fr-FR', options)} ${unit}`;
}

/** Formate une taille en octets vers une unité lisible (ex. `4,2 Mo`). `null`/`undefined` → `—`. */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 o';
  const exponent = unitExponent(bytes);
  return formatQuantity(bytes / 1024 ** exponent, exponent);
}

/** Formate une vitesse de téléchargement en octets/s (ex. `1,2 Mo/s`). `null`/`undefined` → `—`. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return '—';
  }
  return `${formatSize(bytesPerSecond)}/s`;
}

/** Formate un temps restant estimé (secondes) en `mm:ss` ou `h:mm:ss`. `null`/`undefined` → `—`. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Formate l'espace disque restant d'un dossier serveur (ex. `128 Go libres sur 1,8 To`).
 * `free_bytes`/`total_bytes` valent `null` quand l'espace n'a pas pu être lu (racine non montée) :
 * message explicite plutôt qu'un simple tiret, pour ne pas laisser croire à une valeur anodine.
 */
export function formatFreeSpace(freeBytes: number | null | undefined, totalBytes: number | null | undefined): string {
  if (freeBytes === null || freeBytes === undefined || totalBytes === null || totalBytes === undefined) {
    return 'Espace disque inconnu';
  }
  return `${formatSize(freeBytes)} libres sur ${formatSize(totalBytes)}`;
}

/** Formate une progression en pourcentage (0.0–100.0) en entier borné. `null`/`undefined` → `—`. */
export function formatProgress(progress: number | null | undefined): string {
  if (progress === null || progress === undefined || !Number.isFinite(progress)) return '—';
  return `${Math.round(Math.min(Math.max(progress, 0), 100))}%`;
}
