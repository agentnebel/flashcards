import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, parseDelimited } from './csv';

describe('detectDelimiter', () => {
  it('erkennt Komma, Tab und Semikolon', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('zählt Trennzeichen in Anführungszeichen nicht mit', () => {
    expect(detectDelimiter('"a;b;c;d;e"\tx\n"1;2;3;4;5"\ty')).toBe('\t');
  });
});

describe('parseDelimited', () => {
  it('parst einfache Zeilen', () => {
    expect(parseDelimited('a,b\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('behandelt Anführungszeichen mit ""-Escaping und eingebetteten Zeilenumbrüchen', () => {
    expect(parseDelimited('"sag ""hi""","zwei\nzeilen"', ',')).toEqual([['sag "hi"', 'zwei\nzeilen']]);
  });
  it('behandelt CRLF und alleinstehendes CR als Zeilenende', () => {
    expect(parseDelimited('a,b\r\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseDelimited('a,b\rc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('entfernt komplett leere Zeilen', () => {
    expect(parseDelimited('a,b\n,\n\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseCsv', () => {
  it('entfernt ein führendes BOM (Excel „CSV UTF-8")', () => {
    const { rows } = parseCsv('﻿a,b\n1,2');
    expect(rows[0]).toEqual(['a', 'b']);
  });
});
