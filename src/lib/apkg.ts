// .apkg-Import: entpackt das ZIP (fflate), liest die Anki-SQLite-Collection
// (sql.js, lazy via dynamischen apkg-Chunk geladen), mappt Anki-Notiztypen auf
// unsere NoteTypes, importiert Notizen und übernimmt referenzierte Bilder.
//
// Unterstützt das ältere, unkomprimierte Format (collection.anki21 / collection.anki2
// + JSON-"media"-Manifest). Das neue, zstd-komprimierte .anki21b wird erkannt und mit
// klarer Anleitung abgelehnt (in Anki „Support older Anki versions" beim Export wählen).

import { strFromU8 } from 'fflate';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { db } from '../db/db';
import type { Card, Media, Note, NoteType, OutboxItem } from '../db/db';
import { createEmptyCard } from '../scheduler/fsrs';
import { generateCards } from './cardgen';
import { uuid } from '../db/ids';
import { withLocalDataOperation } from '../db/localDataLock';
import { compressImage } from './media';
import { unzipSafely } from './zipSafety';

const FIELD_SEP = '';
const MAX_APKG_BYTES = 100 * 1024 * 1024;
const MAX_APKG_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_APKG_ENTRY_BYTES = 150 * 1024 * 1024;
const MAX_APKG_ENTRIES = 10_000;
const IMG_RE = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi;
const FLASHMEDIA_RE = /flashmedia:([a-f0-9]{64})/g;
export const MAX_SYNC_MEDIA_BYTES = 15 * 1024 * 1024;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * SQL/JSON-Daten aus .apkg sind untrusted Runtime-Daten. Vor dem ersten
 * IndexedDB-Write werden sie vollständig in unsere interne Form überführt.
 */
function parseAnkiModels(value: unknown): Record<string, AnkiModel> {
  if (!isRecord(value)) throw new Error('Ungültige Anki-Notiztypen im Paket.');
  const parsed: Record<string, AnkiModel> = {};

  for (const [modelId, rawModel] of Object.entries(value)) {
    if (!modelId || !isRecord(rawModel)) {
      throw new Error('Ungültiger Anki-Notiztyp im Paket.');
    }
    if (
      rawModel.name !== undefined && typeof rawModel.name !== 'string' ||
      rawModel.css !== undefined && typeof rawModel.css !== 'string' ||
      rawModel.type !== undefined && rawModel.type !== 0 && rawModel.type !== 1
    ) {
      throw new Error(`Ungültiger Anki-Notiztyp: ${modelId}`);
    }
    if (!Array.isArray(rawModel.flds)) {
      throw new Error(`Ungültige Feldliste im Anki-Notiztyp: ${modelId}`);
    }
    const fields = rawModel.flds.map((rawField) => {
      if (
        !isRecord(rawField) ||
        typeof rawField.name !== 'string' ||
        !rawField.name.trim() ||
        !validOrdinal(rawField.ord)
      ) {
        throw new Error(`Ungültiges Feld im Anki-Notiztyp: ${modelId}`);
      }
      return { name: rawField.name, ord: rawField.ord };
    });
    const fieldNames = new Set(fields.map((field) => field.name));
    const fieldOrdinals = new Set(fields.map((field) => field.ord));
    if (fieldNames.size !== fields.length || fieldOrdinals.size !== fields.length) {
      throw new Error(`Doppelte Felder im Anki-Notiztyp: ${modelId}`);
    }

    const rawTemplates = rawModel.tmpls === undefined ? [] : rawModel.tmpls;
    if (!Array.isArray(rawTemplates)) {
      throw new Error(`Ungültige Vorlagenliste im Anki-Notiztyp: ${modelId}`);
    }
    const templates = rawTemplates.map((rawTemplate) => {
      if (
        !isRecord(rawTemplate) ||
        typeof rawTemplate.name !== 'string' ||
        typeof rawTemplate.qfmt !== 'string' ||
        typeof rawTemplate.afmt !== 'string' ||
        !validOrdinal(rawTemplate.ord)
      ) {
        throw new Error(`Ungültige Vorlage im Anki-Notiztyp: ${modelId}`);
      }
      return {
        name: rawTemplate.name,
        qfmt: rawTemplate.qfmt,
        afmt: rawTemplate.afmt,
        ord: rawTemplate.ord,
      };
    });
    const templateOrdinals = new Set(templates.map((template) => template.ord));
    if (templateOrdinals.size !== templates.length) {
      throw new Error(`Doppelte Vorlagen im Anki-Notiztyp: ${modelId}`);
    }

    parsed[modelId] = {
      ...(typeof rawModel.name === 'string' ? { name: rawModel.name } : {}),
      ...(typeof rawModel.type === 'number' ? { type: rawModel.type } : {}),
      ...(typeof rawModel.css === 'string' ? { css: rawModel.css } : {}),
      flds: fields,
      tmpls: templates,
    };
  }
  return parsed;
}

function parseAnkiNoteRows(
  values: unknown,
  models: Record<string, AnkiModel>,
): [string, string, string][] {
  if (!Array.isArray(values)) throw new Error('Ungültige Anki-Notizen im Paket.');
  return values.map((rawRow, index) => {
    if (!Array.isArray(rawRow) || rawRow.length < 3) {
      throw new Error(`Ungültige Anki-Notiz in Zeile ${index + 1}.`);
    }
    const [guid, mid, flds] = rawRow;
    const modelId =
      typeof mid === 'string'
        ? mid
        : typeof mid === 'number' && Number.isFinite(mid)
          ? String(mid)
          : '';
    if (
      typeof guid !== 'string' ||
      !guid ||
      !modelId ||
      typeof flds !== 'string' ||
      !models[modelId]
    ) {
      throw new Error(`Ungültige Anki-Notiz in Zeile ${index + 1}.`);
    }
    return [guid, modelId, flds];
  });
}

export type ApkgMediaSkipReason =
  | 'empty'
  | 'svg'
  | 'unsupported'
  | 'normalization-failed'
  | 'still-too-large';

export type PreparedApkgMedia =
  | {
      ok: true;
      blob: Blob;
      mime: string;
      width: number;
      height: number;
      normalized: boolean;
    }
  | { ok: false; reason: ApkgMediaSkipReason };

type ImageNormalizer = typeof compressImage;

interface PrepareApkgMediaOptions {
  normalizeImage?: ImageNormalizer;
  maxBytes?: number;
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

/**
 * Gleicht Medien aus einem Anki-Paket an den Upload-Vertrag des Workers an:
 * nur Rasterbilder, nicht leer und höchstens 15 MiB. Übergroße, dekodierbare
 * Rasterbilder laufen durch dieselbe Normalisierung wie manuell eingefügte Bilder.
 */
export async function prepareApkgMedia(
  filename: string,
  bytes: Uint8Array,
  options: PrepareApkgMediaOptions = {},
): Promise<PreparedApkgMedia> {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  const mime = mimeFromName(filename);
  if (mime === 'image/svg+xml') return { ok: false, reason: 'svg' };
  if (!mime.startsWith('image/')) return { ok: false, reason: 'unsupported' };

  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const maxBytes = options.maxBytes ?? MAX_SYNC_MEDIA_BYTES;
  if (blob.size <= maxBytes) {
    const { width, height } = await imageSize(blob);
    return { ok: true, blob, mime, width, height, normalized: false };
  }

  try {
    const normalized = await (options.normalizeImage ?? compressImage)(blob);
    if (
      normalized.blob.size === 0 ||
      normalized.blob.size > maxBytes ||
      !normalized.mime.startsWith('image/') ||
      normalized.mime === 'image/svg+xml'
    ) {
      return { ok: false, reason: 'still-too-large' };
    }
    return { ok: true, ...normalized, normalized: true };
  } catch {
    return { ok: false, reason: 'normalization-failed' };
  }
}

export async function importApkg(file: File, deckId: string): Promise<ApkgResult> {
  return withLocalDataOperation(() => importApkgUnlocked(file, deckId));
}

async function importApkgUnlocked(file: File, deckId: string): Promise<ApkgResult> {
  if (!(await db.decks.get(deckId))) throw new Error('Ziel-Deck wurde nicht gefunden.');
  if (file.size > MAX_APKG_BYTES) throw new Error('Die .apkg-Datei ist zu groß (max. 100 MB).');
  const warnings: string[] = [];
  const now = Date.now();
  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipSafely(archiveBytes, {
    maxEntries: MAX_APKG_ENTRIES,
    maxEntryBytes: MAX_APKG_ENTRY_BYTES,
    maxUncompressedBytes: MAX_APKG_UNCOMPRESSED_BYTES,
    label: 'Anki-Paket',
  });

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
    const modelsJson = colRes[0]?.values?.[0]?.[0];
    if (typeof modelsJson !== 'string') {
      throw new Error('Anki-Paket enthält keine gültigen Notiztypen.');
    }
    const models = parseAnkiModels(JSON.parse(modelsJson) as unknown);

    // Auch sämtliche Notizzeilen validieren, bevor Medien oder Fachdaten in
    // IndexedDB geschrieben werden. Unbekannte Model-IDs sind ein kaputtes Paket,
    // kein Grund für einen stillen Teilimport.
    const notesRes = sqldb.exec('SELECT guid, mid, flds FROM notes');
    const rows = parseAnkiNoteRows(notesRes[0]?.values ?? [], models);

    const modelToNt: Record<string, string> = {};
    const modelFields: Record<string, string[]> = {};
    const modelNt: Record<string, NoteType> = {}; // im Speicher, um DB-Lesen in der Transaktion zu vermeiden
    for (const [mid, model] of Object.entries(models)) {
      const fields = [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
      const kind: NoteType['kind'] = model.type === 1 ? 'cloze' : 'standard';
      const resolvedFields = fields.length ? fields : ['Vorderseite', 'Rückseite'];
      const templates = [...(model.tmpls ?? [])]
        .sort((a, b) => a.ord - b.ord)
        .map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt }));
      const ntId = uuid();
      const nt: NoteType = {
        id: ntId,
        name: model.name ?? 'Importiert',
        kind,
        fields: resolvedFields,
        templates: templates.length
          ? templates
          : kind === 'cloze'
            ? [{
                name: 'Cloze',
                qfmt: `{{cloze:${resolvedFields[0]}}}`,
                afmt: `{{cloze:${resolvedFields[0]}}}`,
              }]
            : [{
                name: 'Karte 1',
                qfmt: `{{${resolvedFields[0]}}}`,
                afmt: '{{FrontSide}}',
              }],
        css: model.css ?? '',
        updatedAt: now,
      };
      modelToNt[mid] = ntId;
      modelFields[mid] = nt.fields;
      modelNt[mid] = nt;
    }

    // --- Medien-Manifest (JSON: { "0": "bild.jpg", ... }) ---
    let mediaMap: Record<string, string> = {};
    if (entries['media']) {
      try {
        const rawMediaMap = JSON.parse(strFromU8(entries['media'])) as unknown;
        if (
          !isRecord(rawMediaMap) ||
          Object.values(rawMediaMap).some((filename) => typeof filename !== 'string')
        ) {
          throw new Error('invalid media manifest');
        }
        mediaMap = rawMediaMap as Record<string, string>;
      } catch {
        warnings.push('Medien-Manifest konnte nicht gelesen werden.');
      }
    }
    const nameToNum: Record<string, string> = {};
    for (const [num, fname] of Object.entries(mediaMap)) nameToNum[fname] = num;

    const nameToHash: Record<string, string> = {};
    const mediaSkips: Record<ApkgMediaSkipReason, string[]> = {
      empty: [],
      svg: [],
      unsupported: [],
      'normalization-failed': [],
      'still-too-large': [],
    };
    const existingMediaHashes = new Set(
      (await db.media.orderBy('hash').keys()) as string[],
    );
    const stagedMedia = new Map<string, Media>();
    let normalizedMediaCount = 0;
    async function ensureMedia(filename: string): Promise<void> {
      if (filename in nameToHash) return;
      const num = nameToNum[filename];
      const bytes = num !== undefined ? entries[num] : undefined;
      if (!bytes) return;
      const prepared = await prepareApkgMedia(filename, bytes);
      if (!prepared.ok) {
        mediaSkips[prepared.reason].push(filename);
        nameToHash[filename] = '';
        return;
      }
      if (prepared.normalized) normalizedMediaCount++;
      const preparedBytes = new Uint8Array(await prepared.blob.arrayBuffer());
      const hash = await sha256Hex(preparedBytes);
      if (!existingMediaHashes.has(hash) && !stagedMedia.has(hash)) {
        stagedMedia.set(hash, {
          hash,
          blob: prepared.blob,
          mime: prepared.mime,
          size: prepared.blob.size,
          width: prepared.width,
          height: prepared.height,
          createdAt: now,
          synced: 0,
        });
      }
      nameToHash[filename] = hash;
    }

    // Pass 1: alle referenzierten Bilder einsammeln und vollständig vorbereiten.
    // Geschrieben werden sie erst gemeinsam mit Notizen/Karten in EINER Transaktion.
    const allNames = new Set<string>();
    for (const [, , flds] of rows) {
      for (const v of String(flds).split(FIELD_SEP)) {
        for (const m of v.matchAll(IMG_RE)) allNames.add(safeDecode(m[2]));
      }
    }
    for (const n of allNames) await ensureMedia(n);

    const mediaNames = (names: string[]): string => {
      const sample = names.slice(0, 3).join(', ');
      return names.length > 3 ? `${sample}, …` : sample;
    };
    if (normalizedMediaCount > 0) {
      warnings.push(
        `${normalizedMediaCount} übergroße${normalizedMediaCount === 1 ? 's Rasterbild wurde' : ' Rasterbilder wurden'} ` +
          'für den Sync komprimiert.',
      );
    }
    if (mediaSkips.svg.length > 0) {
      warnings.push(
        `${mediaSkips.svg.length} SVG-${mediaSkips.svg.length === 1 ? 'Datei wurde' : 'Dateien wurden'} übersprungen: ` +
          'SVG wird vom Medien-Sync nicht unterstützt ' +
          `(${mediaNames(mediaSkips.svg)}).`,
      );
    }
    if (mediaSkips.unsupported.length > 0) {
      warnings.push(
        `${mediaSkips.unsupported.length} ${mediaSkips.unsupported.length === 1 ? 'Datei wurde' : 'Dateien wurden'} ` +
          'wegen eines nicht unterstützten Bildformats übersprungen ' +
          `(${mediaNames(mediaSkips.unsupported)}).`,
      );
    }
    if (mediaSkips.empty.length > 0) {
      warnings.push(
        `${mediaSkips.empty.length} leere ${mediaSkips.empty.length === 1 ? 'Mediendatei wurde' : 'Mediendateien wurden'} ` +
          `übersprungen (${mediaNames(mediaSkips.empty)}).`,
      );
    }
    const oversized = [...mediaSkips['normalization-failed'], ...mediaSkips['still-too-large']];
    if (oversized.length > 0) {
      warnings.push(
        `${oversized.length} übergroße${oversized.length === 1 ? 's Bild konnte' : ' Bilder konnten'} nicht auf die ` +
          'Sync-Grenze von 15 MiB reduziert werden ' +
          `und ${oversized.length === 1 ? 'wurde' : 'wurden'} übersprungen (${mediaNames(oversized)}).`,
      );
    }

    const rewrite = (value: string): string =>
      value.replace(IMG_RE, (full, pre: string, src: string, post: string) => {
        const h = nameToHash[safeDecode(src)];
        return h ? `${pre}flashmedia:${h}${post}` : full;
      });

    // Bereits vorhandene Anki-guids: erneut importierte Notizen werden übersprungen,
    // statt jede Karte (und Medien) bei jedem Re-Import zu duplizieren.
    const existingGuids = new Set((await db.notes.orderBy('guid').keys()) as string[]);
    const insertedModelIds = new Set<string>();
    const stagedNoteTypes: NoteType[] = [];
    const stagedNotes: Note[] = [];
    const stagedCards: Card[] = [];
    const stagedOutbox: Omit<OutboxItem, 'id'>[] = [];
    let skipped = 0;
    let skippedEmpty = 0;

    // Pass 2: Den kompletten Import zunächst nur im Speicher aufbauen. Erst wenn auch
    // die letzte Zeile und jedes Template fehlerfrei verarbeitet wurden, folgt genau
    // eine IndexedDB-Transaktion über Medien, Notiztypen, Notizen, Karten und Outbox.
    for (const [noteGuid, modelId, flds] of rows) {
      const ntId = modelToNt[modelId];
      const fieldNames = modelFields[modelId];
      const nt = modelNt[modelId];
      // parseAnkiNoteRows hat diese Beziehungen bereits geprüft. Der Guard schützt
      // zusätzlich vor internen Mapping-Regressions, bevor geschrieben wird.
      if (!ntId || !fieldNames || !nt) {
        throw new Error(`Anki-Notiz verweist auf unbekannten Notiztyp: ${modelId}`);
      }
      if (existingGuids.has(noteGuid)) { skipped++; continue; }
      const values = flds.split(FIELD_SEP);
      const fields: Record<string, string> = {};
      fieldNames.forEach((name, index) => {
        fields[name] = rewrite(values[index] ?? '');
      });
      if (!Object.values(fields).some((value) => value.trim())) continue;

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
      };
      const cardSpecs = generateCards(note, nt);
      if (cardSpecs.length === 0) { skippedEmpty++; continue; }
      existingGuids.add(noteGuid);

      if (!insertedModelIds.has(modelId)) {
        insertedModelIds.add(modelId);
        stagedNoteTypes.push(nt);
        stagedOutbox.push({
          op: 'upsert',
          entity: 'noteType',
          entityId: ntId,
          payload: nt,
          createdAt: now,
        });
      }

      const cards: Card[] = cardSpecs.map((spec) => {
        const fsrs = createEmptyCard(new Date(now));
        return {
          id: uuid(),
          noteId: id,
          deckId,
          noteTypeId: ntId,
          templateOrd: spec.templateOrd,
          clozeNum: spec.clozeNum,
          fsrs,
          due: fsrs.due,
          suspended: 0,
          updatedAt: now,
        };
      });
      stagedNotes.push(note);
      stagedCards.push(...cards);
      stagedOutbox.push({
        op: 'upsert',
        entity: 'note',
        entityId: id,
        payload: note,
        createdAt: now,
      });
      for (const card of cards) {
        stagedOutbox.push({
          op: 'upsert',
          entity: 'card',
          entityId: card.id,
          payload: card,
          createdAt: now,
        });
      }
    }

    // Medien aus übersprungenen GUIDs oder leeren/templatelosen Notizen gehören
    // nicht zum erfolgreichen Import. Nur Hashes committen, die tatsächlich in
    // einer der vorbereiteten neuen Notizen referenziert werden.
    const referencedMediaHashes = new Set<string>();
    for (const note of stagedNotes) {
      for (const field of Object.values(note.fields)) {
        for (const match of field.matchAll(FLASHMEDIA_RE)) {
          referencedMediaHashes.add(match[1]);
        }
      }
    }
    const mediaRows = [...stagedMedia.values()]
      .filter((media) => referencedMediaHashes.has(media.hash));

    await db.transaction(
      'rw',
      [db.media, db.noteTypes, db.notes, db.cards, db.outbox],
      async () => {
        if (mediaRows.length) await db.media.bulkAdd(mediaRows);
        if (stagedNoteTypes.length) await db.noteTypes.bulkAdd(stagedNoteTypes);
        if (stagedNotes.length) await db.notes.bulkAdd(stagedNotes);
        if (stagedCards.length) await db.cards.bulkAdd(stagedCards);
        if (stagedOutbox.length) await db.outbox.bulkAdd(stagedOutbox);
      },
    );

    if (rows.some(([, , f]) => String(f).includes('[sound:'))) {
      warnings.push('Audio-Verweise ([sound:…]) bleiben als Text erhalten (Audio noch nicht unterstützt).');
    }
    if (skipped > 0) {
      warnings.push(`${skipped} bereits vorhandene Notiz(en) übersprungen (gleiche GUID).`);
    }
    if (skippedEmpty > 0) {
      warnings.push(`${skippedEmpty} Notiz(en) ohne Inhalt für ihre Kartenvorlage übersprungen (keine Karte erzeugt).`);
    }

    return {
      noteTypes: stagedNoteTypes.length,
      notes: stagedNotes.length,
      cards: stagedCards.length,
      media: mediaRows.length,
      warnings,
    };
  } finally {
    sqldb.close();
  }
}
