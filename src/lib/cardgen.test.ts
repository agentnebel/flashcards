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
  templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Extra}}' }],
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
  it('Cloze: liest die Nummern aus dem im Template referenzierten Feld', () => {
    const nt: NoteType = {
      ...clozeNt,
      fields: ['Titel', 'Inhalt', 'Zusatz'],
      templates: [{ name: 'Custom', qfmt: '{{Titel}} — {{cloze:Inhalt}}', afmt: '{{cloze:Inhalt}}' }],
    };
    const specs = generateCards(
      makeNote({ Titel: '{{c9::nicht maßgeblich}}', Inhalt: '{{c2::richtig}}', Zusatz: '' }, 'nt2'),
      nt,
    );
    expect(specs.map((spec) => spec.clozeNum)).toEqual([2]);
  });
  it('Standard: Template ohne Inhalt auf der Vorderseite erzeugt keine Karte', () => {
    const nt: NoteType = { ...standardNt, templates: [{ name: 'K', qfmt: '{{Missing}}', afmt: '{{Back}}' }] };
    const specs = generateCards(makeNote({ Front: 'a', Back: 'b' }), nt);
    expect(specs).toEqual([]);
  });
  it('Standard: Bild-only Vorderseite zählt als Inhalt', () => {
    const specs = generateCards(makeNote({ Front: '<img src="flashmedia:abc123">', Back: 'b' }), standardNt);
    expect(specs).toEqual([{ templateOrd: 0, clozeNum: null }]);
  });
  it('Standard: nur Templates mit Inhalt werden erzeugt (optionale Rückwärtskarte)', () => {
    const nt: NoteType = {
      ...standardNt,
      templates: [
        { name: 'Vorwärts', qfmt: '{{Front}}', afmt: '{{Back}}' },
        { name: 'Rückwärts', qfmt: '{{#AddReverse}}{{Back}}{{/AddReverse}}', afmt: '{{Front}}' },
      ],
    };
    const withFlag = generateCards(makeNote({ Front: 'a', Back: 'b', AddReverse: 'y' }), nt);
    const withoutFlag = generateCards(makeNote({ Front: 'a', Back: 'b' }), nt);
    expect(withFlag.map((s) => s.templateOrd)).toEqual([0, 1]);
    expect(withoutFlag.map((s) => s.templateOrd)).toEqual([0]);
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
  it('{{FrontSide}}-Ersetzung interpretiert kein $-Muster aus Feldwerten', () => {
    // "$&" wäre als String.replace-Ersetzungsmuster der komplette Match — ohne Function-
    // Replacer würde "Anfang" hier dupliziert im Back-HTML auftauchen.
    const { back } = renderCard(makeNote({ Front: 'Anfang$&Ende', Back: 'Antwort' }), standardNt, {
      templateOrd: 0,
      clozeNum: null,
    });
    expect(back.match(/Anfang/g)?.length).toBe(1);
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
  it('Anki-Hints verbergen den Feldwert bis zum Aufklappen', () => {
    const nt: NoteType = { ...standardNt, templates: [{ name: 'K', qfmt: '{{hint:Front}}', afmt: '' }] };
    const { front } = renderCard(makeNote({ Front: 'Wert', Back: '' }), nt, { templateOrd: 0, clozeNum: null });
    expect(front).toContain('<details');
    expect(front).toContain('Hinweis anzeigen');
    expect(front).toContain('Wert');
  });
  it('Anki-Type-Filter verrät die Antwort nicht auf der Vorderseite', () => {
    const nt: NoteType = {
      ...standardNt,
      templates: [{ name: 'K', qfmt: '{{type:Front}}', afmt: '{{type:Front}}' }],
    };
    const rendered = renderCard(makeNote({ Front: 'Geheim', Back: '' }), nt, {
      templateOrd: 0,
      clozeNum: null,
    });
    expect(rendered.front).toContain('type="text"');
    expect(rendered.front).not.toContain('Geheim');
    expect(rendered.back).toContain('Geheim');
    expect(rendered.typeAnswer).toBe('Geheim');
  });
  it('parst literal geschweifte Klammern aus FrontSide nicht ein zweites Mal', () => {
    const note = makeNote({ Front: 'Literal {{Unbekannt}}', Back: 'Antwort' });
    const { back } = renderCard(note, standardNt, { templateOrd: 0, clozeNum: null });
    expect(back).toContain('{{Unbekannt}}');
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
  it('rendert Cloze-Lücken über Zeilenumbrüche hinweg', () => {
    const multiline = makeNote({ Text: '{{c1::erste\nzweite::Tipp}}', Extra: '' }, 'nt2');
    const { front, back } = renderCard(multiline, clozeNt, { templateOrd: 0, clozeNum: 1 });
    expect(front).toContain('[Tipp]');
    expect(front).not.toContain('{{c1::');
    expect(back).toContain('erste<br>zweite');
  });
  it('verwendet Custom-qfmt/afmt, FrontSide und explizit platzierte Zusatzfelder', () => {
    const nt: NoteType = {
      ...clozeNt,
      fields: ['Titel', 'Inhalt', 'Details', 'Ungenutzt'],
      templates: [{
        name: 'Custom',
        qfmt: '<header>{{Titel}}</header><main>{{cloze:Inhalt}}</main>',
        afmt: '<section>{{FrontSide}}</section><aside>{{Details}}</aside><footer>{{cloze:Inhalt}}</footer>',
      }],
    };
    const customNote = makeNote({
      Titel: 'Kapitel',
      Inhalt: '{{c3::Antwort::Hinweis}}',
      Details: '**Mehr**',
      Ungenutzt: 'DARF NICHT ERSCHEINEN',
    }, 'nt2');

    const { front, back } = renderCard(customNote, nt, { templateOrd: 0, clozeNum: 3 });

    expect(front).toContain('<header>');
    expect(front).toContain('Kapitel');
    expect(front).toContain('[Hinweis]');
    expect(back).toContain('<section>');
    expect(back).toContain('[Hinweis]');
    expect(back).toContain('<aside><p><strong>Mehr</strong></p>');
    expect(back).toContain('<span class="cloze">Antwort</span>');
    expect(back).not.toContain('DARF NICHT ERSCHEINEN');
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
