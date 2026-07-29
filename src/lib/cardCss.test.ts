import { describe, expect, it } from 'vitest';
import { scopeImportedCardCss } from './cardCss';

describe('scopeImportedCardCss', () => {
  it('kapselt normale Selektoren und bildet Dokumentwurzeln auf den Kartencontainer ab', () => {
    const result = scopeImportedCardCss(`
      html, body, :root, .card, body.nightMode .card {
        color: white;
      }
    `);

    expect(result).toContain(
      '.review-card,.review-card .card,.review-card.nightMode .card{',
    );
    expect(result).not.toMatch(/(?:^|[,}])\s*(?:html|body|:root)\b/);
  });

  it('trennt Selektorlisten nicht an Kommas innerhalb von Funktionen oder Attributen', () => {
    const result = scopeImportedCardCss(
      `.card:is(.front, .back), [data-label="a,b"] { color: red; }`,
      '#card-scope',
    );

    expect(result).toContain(
      '#card-scope .card:is(.front, .back),#card-scope [data-label="a,b"]{',
    );
  });

  it('kapselt Regeln rekursiv in erlaubten responsiven At-Rules', () => {
    const result = scopeImportedCardCss(`
      @media (max-width: 600px) {
        body { font-size: 16px; }
        @supports (display: grid) { .card { display: grid; } }
      }
    `);

    expect(result).toContain('@media (max-width: 600px){.review-card{');
    expect(result).toContain('@supports (display: grid){.review-card .card{');
  });

  it('entfernt globale Imports, Fonts, Keyframes und Properties', () => {
    const result = scopeImportedCardCss(`
      @import url("https://example.test/font.css");
      @font-face { font-family: Evil; src: url("/font.woff2"); }
      @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
      @property --global { syntax: "<color>"; inherits: true; initial-value: red; }
      body { animation: pulse 1s; color: red; }
    `);

    expect(result).toBe('.review-card{ animation: pulse 1s; color: red; }');
    expect(result).not.toContain('@import');
    expect(result).not.toContain('@font-face');
    expect(result).not.toContain('@keyframes');
    expect(result).not.toContain('@property');
  });

  it('verwirft unvollständige Regeln und lehnt einen injizierbaren Scope ab', () => {
    expect(scopeImportedCardCss('.card { color: red')).toBe('');
    expect(() => scopeImportedCardCss('.card{}', '.safe, body')).toThrow('Ungültiger CSS-Scope');
  });
});
