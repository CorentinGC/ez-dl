/**
 * Coalescence d'appels asynchrones concurrents : deux demandes de même clé partagent la même
 * promesse, une demande de clé différente part indépendamment.
 */

/** Clé d'un probe en vol. L'URL en fait partie : après une navigation SPA le résultat de la vidéo A ne doit pas servir la vidéo B. */
export function probeFlightKey(tabId: number, url: string): string {
  return `${tabId}|${url}`;
}

export interface SingleFlight<T> {
  run: (key: string, task: () => Promise<T>) => Promise<T>;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key, task) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = task().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}
