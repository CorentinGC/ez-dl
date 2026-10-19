import { describe, expect, it } from 'vitest';
import { createTabStateGuard } from './tabStateGuard';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTabStateGuard — mutex par onglet', () => {
  it('exécute les tâches d\'un même onglet l\'une après l\'autre', async () => {
    const guard = createTabStateGuard();
    const order: string[] = [];
    const first = guard.run(1, async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
    });
    const second = guard.run(1, async () => {
      order.push('b:start');
      order.push('b:end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('n\'attend pas les tâches d\'un autre onglet', async () => {
    const guard = createTabStateGuard();
    const order: string[] = [];
    const slow = guard.run(1, async () => {
      await tick();
      order.push('tab1');
    });
    await guard.run(2, async () => {
      order.push('tab2');
    });
    await slow;
    expect(order).toEqual(['tab2', 'tab1']);
  });

  it('continue la chaîne après une tâche en échec', async () => {
    const guard = createTabStateGuard();
    const failing = guard.run(1, () => Promise.reject(new Error('boom')));
    const next = guard.run(1, async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});

describe('createTabStateGuard — génération', () => {
  it('démarre à 0 et s\'incrémente par onglet à chaque invalidation', () => {
    const guard = createTabStateGuard();
    expect(guard.generationOf(1)).toBe(0);
    guard.invalidate(1);
    guard.invalidate(1);
    expect(guard.generationOf(1)).toBe(2);
    expect(guard.generationOf(2)).toBe(0);
  });

  it('permet à une écriture périmée de se reconnaître après une purge', async () => {
    const guard = createTabStateGuard();
    const captured = guard.generationOf(1);
    let isWritten = false;
    const write = guard.run(1, async () => {
      if (guard.generationOf(1) !== captured) return;
      isWritten = true;
    });
    guard.invalidate(1); // purge (fermeture/navigation) avant l'exécution de la tâche en file
    await write;
    expect(isWritten).toBe(false);
  });
});
