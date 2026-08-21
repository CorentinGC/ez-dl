/**
 * Formatage lisible de tailles, débits, durées et ETA — utilisé par la popup (fiches source
 * et suivi des jobs). Fonctions pures.
 */

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** Formate un nombre d'octets en unité lisible (ex. `12.3 Mo`). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 o';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = UNITS[exponent] ?? 'o';
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** Formate une vitesse de téléchargement en octets/s (ex. `1.2 Mo/s`). */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Formate une durée en secondes en `hh:mm:ss` ou `mm:ss`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Formate une progression [0..1] en pourcentage entier. */
export function formatProgress(progress: number | null | undefined): string {
  if (progress === null || progress === undefined || !Number.isFinite(progress)) return '—';
  return `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
}
