import { describe, expect, it } from 'vitest';
import { withLocalDataOperation, withLocalDataReset } from './localDataLock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('lokaler Daten-Operationslock', () => {
  it('lässt einen Reset auf einen bereits laufenden Import warten', async () => {
    const gate = deferred();
    const events: string[] = [];
    const importing = withLocalDataOperation(async () => {
      events.push('import-start');
      await gate.promise;
      events.push('import-end');
    });
    await Promise.resolve();

    const resetting = withLocalDataReset(async () => {
      events.push('reset');
    });
    await Promise.resolve();
    expect(events).toEqual(['import-start']);

    gate.resolve();
    await Promise.all([importing, resetting]);
    expect(events).toEqual(['import-start', 'import-end', 'reset']);
  });

  it('weist neue Imports ab, sobald ein Reset vorgemerkt ist', async () => {
    const gate = deferred();
    const resetting = withLocalDataReset(() => gate.promise);
    await expect(withLocalDataOperation(async () => undefined)).rejects.toThrow(/Abmeldung/);
    gate.resolve();
    await resetting;
  });
});
