// .apkg-Import: entpackt das ZIP (fflate), liest die Anki-SQLite-Collection
// (sql.js, lazy via dynamischen apkg-Chunk geladen), mappt Anki-Notiztypen auf
// unsere NoteTypes, importiert Notizen und übernimmt referenzierte Bilder.
//
// Unterstützt das ältere, unkomprimierte Format (collection.anki21 / collection.anki2
// + JSON-"media"-Manifest). Das neue, zstd-komprimierte .anki21b wird erkannt und mit
// klarer Anleitung abgelehnt (in Anki „Support older Anki versions" beim Export wählen).

import { unzipSync, strFromU8 } from 'fflate';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { db } from '../db/db';
import type { Card, Media, Note, NoteType } from '../db/db';
import { createEmptyCard } from '../scheduler/fsrs';
import { generateCards } from './cardgen';
import { uuid } from '../db/ids';

const FIELD_SEP = '';
const IMG_RE = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi;

export interface ApkgResult {
  noteTypes: number;
  notes: number;
  cards: number;
  media: number;
  warnings: string[];
}

interface AnkiField {
  name: string;
  ord: number;
}
interface AnkiTemplate {
  name: string;
  qfmt: string;
  afmt: string;
  ord: number;
}
interface AnkiModel {
  name?: string;
  type?: number; // 0 = standard, 1 = cloze
  css?: string;
  flds: AnkiField[];
  tmpls: AnkiTemplate[];
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  };
  return map[ext] ?? 'application/octet-stream';
}

// decodeURIComponent wirft bei ungültigen %-Sequenzen (z. B. "100%.png") und würde
// sonst den ganzen Import abbrechen — hier tolerant auf den Rohwert zurückfallen.
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes); // eigener ArrayBuffer (kein SharedArrayBuffer)
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close();
      return dims;
    } catch {
      /* ignore */
    }
  }
  return { width: 0, height: 0 };
}

export async function importApkg(file: File, deckId: string): Promise<ApkgResult> {
  const warnings: string[] = [];
  const now = Date.now();
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));

  const collName = entries['collection.anki21']
    ? 'collection.anki21'
    : entries['collection.anki2']
      ? 'collection.anki2'
      : null;
  if (!collName) {
    if (entries['collection.anki21b']) {
      throw new Error(
        'Dieses .apkg nutzt das neue komprimierte Format (.anki21b). Bitte in Anki erneut ' +
          'exportieren und dabei „Support older Anki versions" aktivieren.',
      );
    }
    throw new Error('Keine Anki-Collection (collection.anki2) im Paket gefunden.');
  }

  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const sqldb = new SQL.Database(entries[collName]);

  try {
    // --- Notiztypen (models) aus der col-Tabelle ---
    const colRes = sqldb.exec('SELECT models FROM col LIMIT 1');
    const modelsJson = (colRes[0]?.values?.[0]?.[0] as string) ?? '{}';
    const models = JSON.parse(modelsJson) as Record<string, AnkiModel>;

    const modelToNt: Record<string, string> = {};
    const modelFields: Record<string, string[]> = {};
    const modelNt: Record<string, NoteType> = {}; // im Speicher, um DB-Lesen in der Transaktion zu vermeiden
    let noteTypeCount = 0;
    for (const [mid, model] of Object.entries(models)) {
      const fields = [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
      const templates = [...(model.tmpls ?? [])]
        .sort((a, b) => a.ord - b.ord)
        .map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt }));
      const ntId = uuid();
      const nt: NoteType = {
        id: ntId,
        name: model.name ?? 'Importiert',
        kind: model.type === 1 ? 'cloze' : 'standard',
        fields: fields.length ? fields : ['Vorderseite', 'Rückseite'],
        templates: templates.length
          ? templates
          : [{ name: 'Karte 1', qfmt: `{{${fields[0] ?? 'Vorderseite'}}}`, afmt: '{{FrontSide}}' }],
        css: model.css ?? '',
        updatedAt: now,
        usn: -1,
      };
      modelToNt[mid] = ntId;
      modelFields[mid] = nt.fields;
      modelNt[mid] = nt;
      await db.noteTypes.add(nt);
      await db.outbox.add({ op: 'upsert', entity: 'noteType', entityId: ntId, payload: nt, createdAt: now });
      noteTypeCount++;
    }

    // --- Medien-Manifest (JSON: { "0": "bild.jpg", ... }) ---
    let mediaMap: Record<string, string> = {};
    if (entries['media']) {
      try {
        mediaMap = JSON.parse(strFromU8(entries['media'])) as Record<string, string>;
      } catch {
        warnings.push('Medien-Manifest konnte nicht gelesen werden.');
      }
    }
    const nameToNum: Record<string, string> = {};
    for (const [num, fname] of Object.entries(mediaMap)) nameToNum[fname] = num;

    const nameToHash: Record<string, string> = {};
    let mediaCount = 0;
    async function ensureMedia(filename: string): Promise<void> {
      if (filename in nameToHash) return;
      const num = nameToNum[filename];
      const bytes = num !== undefined ? entries[num] : undefined;
      if (!bytes) return;
      const hash = await sha256Hex(bytes);
      if (!(await db.media.get(hash))) {
        const mime = mimeFromName(filename);
        const blob = new Blob([bytes], { type: mime });
        const { width, height } = mime.startsWith('image/') ? await imageSize(blob) : { width: 0, height: 0 };
        const media: Media = { hash, blob, mime, size: blob.size, width, height, createdAt: now, usn: -1, synced: 0 };
        await db.media.add(media);
        mediaCount++;
      }
      nameToHash[filename] = hash;
    }

    // --- Notizen laden (inkl. Anki-guid für Dedup) ---
    const notesRes = sqldb.exec('SELECT guid, mid, flds FROM notes');
    const rows = (notesRes[0]?.values ?? []) as [string, number | string, string][];

    // Pass 1: alle referenzierten Bilder einsammeln und lokal ablegen.
    const allNames = new Set<string>();
    for (const [, , flds] of rows) {
      for (const v of String(flds).split(FIELD_SEP)) {
        for (const m of v.matchAll(IMG_RE)) allNames.add(safeDecode(m[2]));
      }
    }
    for (const n of allNames) await ensureMedia(n);

    const rewrite = (value: string): string =>
      value.replace(IMG_RE, (full, pre: string, src: string, post: string) => {
        const h = nameToHash[safeDecode(src)];
        return h ? `${pre}flashmedia:${h}${post}` : full;
      });

    // Bereits vorhandene Anki-guids: erneut importierte Notizen werden übersprungen,
    // statt jede Karte (und Medien) bei jedem Re-Import zu duplizieren.
    const existingGuids = new Set((await db.notes.orderBy('guid').keys()) as string[]);
    let skipped = 0;

    // Pass 2: Notizen + Karten in Batches anlegen.
    let noteCount = 0;
    let cardCount = 0;
    const CHUNK = 200;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const slice = rows.slice(start, start + CHUNK);
      await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
        for (const [guid, mid, flds] of slice) {
          const ntId = modelToNt[String(mid)];
          const fieldNames = modelFields[String(mid)];
          const nt = modelNt[String(mid)];
          if (!ntId || !fieldNames || !nt) continue;
          const noteGuid = String(guid);
          if (existingGuids.has(noteGuid)) { skipped++; continue; } // schon importiert → überspringen
          const values = String(flds).split(FIELD_SEP);
          const fields: Record<string, string> = {};
          fieldNames.forEach((name, i) => {
            fields[name] = rewrite(values[i] ?? '');
          });
          if (!Object.values(fields).some((v) => v.trim())) continue;
          existingGuids.add(noteGuid); // auch innerhalb desselben Imports nicht doppeln

          const id = uuid();
          const note: Note = {
            id,
            guid: noteGuid,
            noteTypeId: ntId,
            deckId,
            fields,
            tags: [],
            sortField: fields[fieldNames[0]] ?? '',
            updatedAt: now,
            usn: -1,
          };
          const cards: Card[] = generateCards(note, nt).map((s) => {
            const fsrs = createEmptyCard(new Date());
            return {
              id: uuid(),
              noteId: id,
              deckId,
              noteTypeId: ntId,
              templateOrd: s.templateOrd,
              clozeNum: s.clozeNum,
              fsrs,
              due: fsrs.due,
              suspended: 0,
              updatedAt: now,
              usn: -1,
            };
          });
          await db.notes.add(note);
          await db.cards.bulkAdd(cards);
          await db.outbox.add({ op: 'upsert', entity: 'note', entityId: id, payload: note, createdAt: now });
          for (const c of cards) {
            await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
          }
          noteCount++;
          cardCount += cards.length;
        }
      });
    }

    if (rows.some(([, , f]) => String(f).includes('[sound:'))) {
      warnings.push('Audio-Verweise ([sound:…]) bleiben als Text erhalten (Audio noch nicht unterstützt).');
    }
    if (skipped > 0) {
      warnings.push(`${skipped} bereits vorhandene Notiz(en) übersprungen (gleiche GUID).`);
    }

    return { noteTypes: noteTypeCount, notes: noteCount, cards: cardCount, media: mediaCount, warnings };
  } finally {
    sqldb.close();
  }
}
