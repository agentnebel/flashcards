import { describe, expect, it } from 'vitest';
import { clozeNumbers, generateCards, renderCard } from './cardgen';
import type { Note, NoteType } from '../db/db';

function makeNote(fields: Record<string, string>, noteTypeId = 'nt1'): Note {
  return {
    id: 'n1',
    guid: 'g1',
    noteTypeId,
    deckId: 'd1',
    fields,
    tags: [],
    sortField: Object.values(fields)[0] ?? '',
    updatedAt: 0,
  };
}

const standardNt: NoteType = {
  id: 'nt1',
  name: 'Standard',
  kind: 'standard',
  fields: ['Front', 'Back'],
  templates: [{ name: 'Karte 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }],
  css: '',
  updatedAt: 0,
};

const clozeNt: NoteType = {
  id: 'nt2',
  name: 'Cloze',
  kind: 'cloze',
  fields: ['Text', 'Extra'],
  templates: [{ name: 'Cloze', qfmt: '', afmt: '' }],
  css: '',
  updatedAt: 0,
};

describe('clozeNumbers', () => {
  it('findet alle Cloze-Nummern dedupliziert und sortiert', () => {
    expect(clozeNumbers('{{c2::b}} {{c1::a}} {{c1::c}}')).toEqual([1, 2]);
  });
  it('leerer Text → keine Nummern', () => {
    expect(clozeNumbers('kein cloze')).toEqual([]);
  });
});

describe('generateCards', () => {
  it('Standard: eine Karte pro Template', () => {
    const specs = generateCards(makeNote({ Front: 'a', Back: 'b' }), standardNt);
    expect(specs).toEqual([{ templateOrd: 0, clozeNum: null }]);
  });
  it('Cloze: eine Karte pro Cloze-Nummer', () => {
    const specs = generateCards(makeNote({ Text: '{{c1::a}} {{c3::b}}' }, 'nt2'), clozeNt);
    expect(specs.map((s) => s.clozeNum)).toEqual([1, 3]);
  });
  it('Cloze ohne Lücken: eine Fallback-Karte (c1)', () => {
    const specs = generateCards(makeNote({ Text: 'ohne' }, 'nt2'), clozeNt);
    expect(specs).toEqual([{ templateOrd: 0, clozeNum: 1 }]);
  });
});

describe('renderCard (Standard)', () => {
  it('rendert Markdown in Feldwerten', () => {
    const { front } = renderCard(makeNote({ Front: '**fett**', Back: 'b' }), standardNt, {
      templateOrd: 0,
      clozeNum: null,
    });
    expect(front).toContain('<strong>fett</strong>');
  });
  it('ersetzt {{FrontSide}} auf der Rückseite', () => {
    const { back } = renderCard(makeNote({ Front: 'Frage', Back: 'Antwort' }), standardNt, {
      templateOrd: 0,
      clozeNum: null,
    });
    expect(back).toContain('Frage');
    expect(back).toContain('Antwort');
  });
  it('Konditionalfelder: {{#F}} nur bei gefülltem, {{^F}} nur bei leerem Feld', () => {
    const nt: NoteType = {
      ...standardNt,
      templates: [{ name: 'K', qfmt: '{{#Back}}mit{{/Back}}{{^Back}}ohne{{/Back}}', afmt: '{{Back}}' }],
    };
    const filled = renderCard(makeNote({ Front: 'f', Back: 'x' }), nt, { templateOrd: 0, clozeNum: null });
    const empty = renderCard(makeNote({ Front: 'f', Back: '' }), nt, { templateOrd: 0, clozeNum: null });
    expect(filled.front).toContain('mit');
    expect(filled.front).not.toContain('ohne');
    expect(empty.front).toContain('ohne');
  });
  it('Anki-Feldfilter ({{hint:Feld}}) werden auf den Feldwert reduziert', () => {
    const nt: NoteType = { ...standardNt, templates: [{ name: 'K', qfmt: '{{hint:Front}}', afmt: '' }] };
    const { front } = renderCard(makeNote({ Front: 'Wert', Back: '' }), nt, { templateOrd: 0, clozeNum: null });
    expect(front).toContain('Wert');
  });
});

describe('renderCard (Cloze)', () => {
  const note = makeNote({ Text: '{{c1::Antwort::Tipp}} und {{c2::zwei}}', Extra: '' }, 'nt2');
  it('Vorderseite: aktive Lücke verdeckt (mit Hint), andere offen', () => {
    const { front } = renderCard(note, clozeNt, { templateOrd: 0, clozeNum: 1 });
    expect(front).toContain('[Tipp]');
    expect(front).toContain('zwei');
    expect(front).not.toContain('Antwort');
  });
  it('Rückseite: aktive Lücke aufgedeckt als cloze-Span', () => {
    const { back } = renderCard(note, clozeNt, { templateOrd: 0, clozeNum: 1 });
    expect(back).toContain('<span class="cloze">Antwort</span>');
  });
});

describe('renderCard (Sanitizing)', () => {
  it('entfernt Skripte und Event-Handler, behält flashmedia-Bilder', () => {
    const note = makeNote({
      Front: '<img src="flashmedia:abc123" onerror="alert(1)"><script>alert(2)</script>Text',
      Back: '',
    });
    const { front } = renderCard(note, standardNt, { templateOrd: 0, clozeNum: null });
    expect(front).toContain('src="flashmedia:abc123"');
    expect(front).not.toContain('onerror');
    expect(front).not.toContain('<script');
    expect(front).toContain('Text');
  });
  it('entfernt Skripte auch aus dem Template selbst (fremde .apkg)', () => {
    const nt: NoteType = {
      ...standardNt,
      templates: [{ name: 'K', qfmt: '<script>steal()</script>{{Front}}', afmt: '{{Back}}' }],
    };
    const { front } = renderCard(makeNote({ Front: 'ok', Back: '' }), nt, { templateOrd: 0, clozeNum: null });
    expect(front).not.toContain('<script');
    expect(front).toContain('ok');
  });
});
