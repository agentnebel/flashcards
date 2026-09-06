import { describe, expect, it } from 'vitest';
import { referencedMediaHashes } from './mediaReferences';

describe('referencedMediaHashes', () => {
  it('erhält Referenzen aus Feldern, beiden Vorlagenseiten und CSS ohne Duplikate', () => {
    const fieldHash = 'a'.repeat(64);
    const frontHash = 'b'.repeat(64);
    const backHash = 'c'.repeat(64);
    const cssHash = 'd'.repeat(64);

    expect(referencedMediaHashes(
      [{ fields: { Front: `<img src="flashmedia:${fieldHash}">` } }],
      [{
        templates: [{
          name: 'Karte',
          qfmt: `<img src="flashmedia:${frontHash}"><img src="flashmedia:${fieldHash}">`,
          afmt: `<img src="flashmedia:${backHash}">`,
        }],
        css: `.card { background-image: url("flashmedia:${cssHash}"); }`,
      }],
    )).toEqual(new Set([fieldHash, frontHash, backHash, cssHash]));
  });

  it('akzeptiert nur vollständige Hashes und funktioniert ohne Notiztypen', () => {
    const hash = 'a'.repeat(64);
    expect(referencedMediaHashes([{ fields: {
      Front: `flashmedia:${'a'.repeat(63)} flashmedia:${'a'.repeat(65)} flashmedia:${hash}`,
    } }])).toEqual(new Set([hash]));
    expect(referencedMediaHashes([])).toEqual(new Set());
  });
});
