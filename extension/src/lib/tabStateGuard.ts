/**
 * Garde d'écriture de l'état d'onglet : le service worker traite des dizaines d'événements
 * concurrents par onglet (requêtes sniffées, messages, navigations) qui font tous
 * lecture -> modification -> écriture sur la même clé `storage.session`.
 *
 * - `run` sérialise les tâches d'un même onglet (mutex par chaîne de promesses) : plus de
 *   mise à jour perdue ;
 * - la génération d'un onglet est incrémentée à chaque purge (`invalidate`) : une écriture
 *   lancée avant la purge, dont la génération est périmée, doit être abandonnée par l'appelant
 *   pour ne pas ressusciter l'état d'un onglet fermé ou d'une page quittée.
 *
 * Le compteur vit en mémoire : s'il est perdu au sommeil du worker, aucune opération n'est
 * non plus en vol (le worker ne dort pas pendant un événement).
 */

export interface TabStateGuard {
  generationOf: (tabId: number) => number;
  invalidate: (tabId: number) => void;
  run: <T>(tabId: number, task: () => Promise<T>) => Promise<T>;
}

export function createTabStateGuard(): TabStateGuard {
  const chains = new Map<number, Promise<unknown>>();
  const generations = new Map<number, number>();

  return {
    generationOf: (tabId) => generations.get(tabId) ?? 0,

    invalidate(tabId) {
      generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    },

    run(tabId, task) {
      const previous = chains.get(tabId) ?? Promise.resolve();
      const result = previous.then(task);
      // La chaîne ne doit jamais rester rejetée, sinon la tâche suivante ne s'exécuterait pas.
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      chains.set(tabId, tail);
      void tail.then(() => {
        if (chains.get(tabId) === tail) chains.delete(tabId);
      });
      return result;
    },
  };
}
