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
  it('bevorzugt den strukturell konsistenten Trenner gegenüber häufigen Feldzeichen', () => {
    const csv = 'Front,Back\nalpha;beta;gamma,Antwort\ndelta;epsilon;zeta,Antwort';
    expect(detectDelimiter(csv)).toBe(',');
  });
  it.each([',', '\t', ';'])('erhält alle Felder großer Dateien mit %j als Trenner', (delimiter) => {
    const source = `Front${delimiter}Back\n` + `Frage${delimiter}Antwort\n`.repeat(500);
    const parsed = parseCsv(source);
    expect(parsed.delimiter).toBe(delimiter);
    expect(parsed.rows).toHaveLength(501);
    expect(parsed.rows.slice(1).every((row) =>
      row.length === 2 && row[0] === 'Frage' && row[1] === 'Antwort')).toBe(true);
  });
  it('wertet Zeilenumbrüche in einem angeschnittenen quotierten Feld nicht als Record-Ende', () => {
    const source = 'Front\tBack\n' + `"${'Text;mit;Semikolon\n'.repeat(400)}"\tAntwort\n`;
    expect(detectDelimiter(source)).toBe('\t');
  });
  it('wählt bei einer verkürzten Datenzeile keinen unbenutzten Trenner', () => {
    expect(detectDelimiter('Front,Back\nFrage,Antwort\nNur Frage\n')).toBe(',');
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
