import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight, probeFlightKey } from './singleFlight';

describe('probeFlightKey', () => {
  it('distingue deux URL du même onglet', () => {
    expect(probeFlightKey(1, 'https://a.test/v1')).not.toBe(probeFlightKey(1, 'https://a.test/v2'));
  });

  it('distingue deux onglets sur la même URL', () => {
    expect(probeFlightKey(1, 'https://a.test/v')).not.toBe(probeFlightKey(2, 'https://a.test/v'));
  });
});

describe('createSingleFlight', () => {
  it('partage la promesse pour une même clé et relance après résolution', async () => {
    const flight = createSingleFlight<string>();
    const task = vi.fn().mockResolvedValue('ok');
    const [a, b] = await Promise.all([flight.run('k', task), flight.run('k', task)]);
    expect([a, b]).toEqual(['ok', 'ok']);
    expect(task).toHaveBeenCalledTimes(1);

    await flight.run('k', task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('ne mélange pas les résultats de clés différentes (navigation SPA)', async () => {
    const flight = createSingleFlight<string>();
    const results = await Promise.all([
      flight.run(probeFlightKey(1, 'https://a.test/A'), async () => 'A'),
      flight.run(probeFlightKey(1, 'https://a.test/B'), async () => 'B'),
    ]);
    expect(results).toEqual(['A', 'B']);
  });

  it('libère la clé après un rejet', async () => {
    const flight = createSingleFlight<string>();
    await expect(flight.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(flight.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});
