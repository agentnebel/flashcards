import { db, type Deck, type NoteType } from './db';

const DEFAULT_CSS = `.card{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:1.4rem;
line-height:1.5;text-align:center;color:#e2e8f0}.cloze{color:#38bdf8;font-weight:600}hr{border:none;
border-top:1px solid #334155;margin:1rem 0}`;

// Lege beim ersten Start ein Standard-Deck und die Basis-Notiztypen an.
export async function ensureSeed(): Promise<void> {
  const deckCount = await db.decks.count();
  const ntCount = await db.noteTypes.count();
  const now = Date.now();

  if (ntCount === 0) {
    const types: NoteType[] = [
      {
        id: 'nt-basic',
        name: 'Einfach',
        kind: 'standard',
        fields: ['Vorderseite', 'Rückseite'],
        templates: [
          { name: 'Karte 1', qfmt: '{{Vorderseite}}', afmt: '{{FrontSide}}<hr>{{Rückseite}}' },
        ],
        css: DEFAULT_CSS,
        updatedAt: now,
      },
      {
        id: 'nt-basic-reversed',
        name: 'Einfach (+ Umkehrung)',
        kind: 'standard',
        fields: ['Vorderseite', 'Rückseite'],
        templates: [
          { name: 'Karte 1', qfmt: '{{Vorderseite}}', afmt: '{{FrontSide}}<hr>{{Rückseite}}' },
          { name: 'Karte 2', qfmt: '{{Rückseite}}', afmt: '{{FrontSide}}<hr>{{Vorderseite}}' },
        ],
        css: DEFAULT_CSS,
        updatedAt: now,
      },
      {
        id: 'nt-cloze',
        name: 'Lückentext (Cloze)',
        kind: 'cloze',
        fields: ['Text', 'Extra'],
        templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Extra}}' }],
        css: DEFAULT_CSS,
        updatedAt: now,
      },
    ];
    await db.noteTypes.bulkAdd(types);
  }

  if (deckCount === 0) {
    const deck: Deck = {
      id: 'deck-default',
      name: 'Standard',
      parentId: null,
      newPerDay: 20,
      updatedAt: now,
    };
    await db.decks.add(deck);
  }
}
