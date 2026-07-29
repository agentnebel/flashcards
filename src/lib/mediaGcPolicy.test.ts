import { describe, expect, it } from 'vitest';
import { MEDIA_GC_GRACE_MS, mediaGcAction } from './mediaGcPolicy';

const now = Date.parse('2026-07-29T12:00:00Z');

describe('Remote-Medien-Quarantäne', () => {
  it('markiert eine neu verwaiste Datei zunächst nur', () => {
    expect(mediaGcAction(
      { sha256: 'a'.repeat(64), orphanedAt: null },
      new Set(),
      now,
    )).toBe('mark');
  });

  it('löscht erst nach Ablauf der 30-tägigen Grace Period', () => {
    expect(mediaGcAction(
      { sha256: 'a'.repeat(64), orphanedAt: now - MEDIA_GC_GRACE_MS + 1 },
      new Set(),
      now,
    )).toBe('keep');
    expect(mediaGcAction(
      { sha256: 'a'.repeat(64), orphanedAt: now - MEDIA_GC_GRACE_MS },
      new Set(),
      now,
    )).toBe('delete');
  });

  it('rettet eine wieder referenzierte Datei unabhängig vom Alter', () => {
    const hash = 'a'.repeat(64);
    expect(mediaGcAction(
      { sha256: hash, orphanedAt: now - MEDIA_GC_GRACE_MS * 2 },
      new Set([hash]),
      now,
    )).toBe('rescue');
  });
});
