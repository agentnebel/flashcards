import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('rendert GFM (fett, Zeilenumbruch als <br>)', () => {
    expect(renderMarkdown('**fett**')).toContain('<strong>fett</strong>');
    expect(renderMarkdown('eins\nzwei')).toContain('<br>');
  });
  it('reicht eingebettetes HTML durch (flashmedia-Bilder, apkg-HTML)', () => {
    expect(renderMarkdown('<img src="flashmedia:aa">')).toContain('flashmedia:aa');
  });
  it('leerer Input → leerer String', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('stripMarkdown', () => {
  it('entfernt Betonungs- und Code-Marker', () => {
    expect(stripMarkdown('**fett** und `code`')).toBe('fett und code');
  });
  it('reduziert Links auf den Text', () => {
    expect(stripMarkdown('[Text](https://x)')).toBe('Text');
  });
  it('entfernt Heading-Marker nur am Zeilenanfang — "C#" bleibt intakt', () => {
    expect(stripMarkdown('# Titel')).toBe('Titel');
    expect(stripMarkdown('C# und F#')).toBe('C# und F#');
  });
  it('entfernt Zitat-Marker nur am Zeilenanfang', () => {
    expect(stripMarkdown('> Zitat')).toBe('Zitat');
    expect(stripMarkdown('1 > 0')).toBe('1 > 0');
  });
});
