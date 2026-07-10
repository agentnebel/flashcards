import { db, type Deck, type NoteType } from './db';

const DEFAULT_CSS = `.card{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:1.4rem;
line-height:1.5;text-align:center;color:#e2e8f0}.cloze{color:#38bdf8;font-weight:600}hr{border:none;
border-top:1px solid #334155;margin:1rem 0}`;

let seeding: Promise<void> | null = null;

// Lege beim ersten Start ein Standard-Deck und die Basis-Notiztypen an.
// Modul-weiter In-Flight-Guard (gleiches Muster wie sync()): ensureSeed() wird u. a. aus
// einem React-Effect aufgerufen, den StrictMode im Dev-Modus zweimal fast gleichzeitig
// feuert. Ohne Guard würden beide Aufrufe `count === 0` lesen, bevor der jeweils andere
// geschrieben hat — der zweite bulkAdd/add liefe dann auf einen Primärschlüssel-Konflikt
// mit den festen IDs (nt-basic, deck-default) und würde als unbehandelte BulkError/
// ConstraintError in der Konsole landen.
export function ensureSeed(): Promise<void> {
  if (seeding) return seeding;
  seeding = ensureSeedInner().finally(() => {
    seeding = null;
  });
  return seeding;
}

async function ensureSeedInner(): Promise<void> {
  // Seed-Daten sind Bootstrap, keine frischeren Benutzeränderungen. Ein fester alter
  // Zeitstempel lässt beim erneuten Login die serverseitige Version gewinnen.
  const seededAt = 0;
  await db.transaction('rw', db.decks, db.noteTypes, db.outbox, async () => {
    const deckCount = await db.decks.count();
    const ntCount = await db.noteTypes.count();

    if (ntCount === 0) {
      const types: NoteType[] = [
        { id: 'nt-basic', name: 'Einfach', kind: 'standard', fields: ['Vorderseite', 'Rückseite'], templates: [{ name: 'Karte 1', qfmt: '{{Vorderseite}}', afmt: '{{FrontSide}}<hr>{{Rückseite}}' }], css: DEFAULT_CSS, updatedAt: seededAt },
        { id: 'nt-basic-reversed', name: 'Einfach (+ Umkehrung)', kind: 'standard', fields: ['Vorderseite', 'Rückseite'], templates: [{ name: 'Karte 1', qfmt: '{{Vorderseite}}', afmt: '{{FrontSide}}<hr>{{Rückseite}}' }, { name: 'Karte 2', qfmt: '{{Rückseite}}', afmt: '{{FrontSide}}<hr>{{Vorderseite}}' }], css: DEFAULT_CSS, updatedAt: seededAt },
        { id: 'nt-cloze', name: 'Lückentext (Cloze)', kind: 'cloze', fields: ['Text', 'Extra'], templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Extra}}' }], css: DEFAULT_CSS, updatedAt: seededAt },
      ];
      await db.noteTypes.bulkAdd(types);
      for (const type of types) await db.outbox.add({ op: 'upsert', entity: 'noteType', entityId: type.id, payload: type, createdAt: seededAt });
    }

    if (deckCount === 0) {
      const deck: Deck = { id: 'deck-default', name: 'Standard', parentId: null, newPerDay: 20, updatedAt: seededAt };
      await db.decks.add(deck);
      await db.outbox.add({ op: 'upsert', entity: 'deck', entityId: deck.id, payload: deck, createdAt: seededAt });
    }
  });
}
