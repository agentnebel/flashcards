// Medien-Sync-Client gegen das R2-gestützte Backend.
//
// Die Haupt-Sync-Schleife ruft diese Funktionen nach dem Daten-Pull/-Push auf.
// Hier bleiben HTTP-Vertrag, lokaler Medienstatus und R2-Revalidierung gekapselt.

import { db, type Media } from '../db/db';
import { sha256Hex } from '../lib/media';
import { referencedMediaHashes } from '../lib/mediaReferences';
import { LocalDataResetError, withLocalDataOperation } from '../db/localDataLock';

const EXISTS_CHUNK = 40;
const MAX_REVALIDATION_CHUNKS_PER_SYNC = 20;
const MAX_PENDING_EXISTS_CHUNKS_PER_SYNC = 40;
const MEDIA_REVALIDATION_CURSOR_KEY = 'mediaRevalidationCursor';
const MEDIA_DOWNLOAD_CURSOR_KEY = 'mediaDownloadCursor';
const MAX_MEDIA_DOWNLOADS_PER_SYNC = 40;
const MEDIA_DOWNLOAD_CONCURRENCY = 4;
const MAX_REMOTE_MEDIA_BYTES = 15 * 1024 * 1024;
const SAFE_REMOTE_MEDIA_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Sync abgebrochen', 'AbortError');
}

/**
 * Prüft lokal referenzierte Medien, die als synchronisiert gelten, erneut gegen R2.
 * Remote fehlende Objekte werden wieder pending, damit uploadPendingMedia sie im selben
 * Sync-Lauf erneut hochlädt. Bei einem unvollständigen/fehlgeschlagenen Exists-Check
 * bleibt der lokale Status unverändert; ein Netzwerkfehler darf keinen Re-Upload-Sturm auslösen.
 */
export async function revalidateReferencedMedia(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ reset: number; complete: boolean }> {
  throwIfAborted(signal);
  const [notes, noteTypes] = await Promise.all([db.notes.toArray(), db.noteTypes.toArray()]);
  throwIfAborted(signal);
  const referenced = referencedMediaHashes(notes, noteTypes);
  if (referenced.size === 0) {
    await withLocalDataOperation(() => db.meta.delete(MEDIA_REVALIDATION_CURSOR_KEY));
    return { reset: 0, complete: true };
  }

  const hashes = [...referenced].sort();
  const local = await db.media.bulkGet(hashes);
  throwIfAborted(signal);
  const synced = hashes.filter((_, index) => local[index]?.synced === 1);
  if (synced.length === 0) {
    await withLocalDataOperation(() => db.meta.delete(MEDIA_REVALIDATION_CURSOR_KEY));
    return { reset: 0, complete: true };
  }

  // Höchstens 800 Hashes pro Sync prüfen und am gespeicherten Cursor fortsetzen. Bewusst
  // nicht innerhalb desselben Laufs zum Listenanfang umbrechen: Nur so ist nach Erreichen
  // des Listenendes eindeutig ein vollständiger Tageszyklus abgeschlossen.
  const cursorMeta = await db.meta.get(MEDIA_REVALIDATION_CURSOR_KEY);
  const cursor = typeof cursorMeta?.value === 'string' ? cursorMeta.value : '';
  const afterCursor = cursor ? synced.findIndex((hash) => hash > cursor) : 0;
  const start = afterCursor >= 0 ? afterCursor : 0;
  const scheduled = synced.slice(
    start,
    start + MAX_REVALIDATION_CHUNKS_PER_SYNC * EXISTS_CHUNK,
  );

  const missing = new Set<string>();
  let lastChecked: string | null = null;
  let interrupted = false;
  try {
    for (let i = 0; i < scheduled.length; i += EXISTS_CHUNK) {
      throwIfAborted(signal);
      const chunk = scheduled.slice(i, i + EXISTS_CHUNK);
      const requested = new Set(chunk);
      const res = await fetch(`${baseUrl}/api/media/exists`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: chunk }),
        signal,
      });
      throwIfAborted(signal);
      if (!res.ok) {
        interrupted = true;
        break;
      }
      const data = (await res.json()) as { missing?: unknown };
      throwIfAborted(signal);
      if (!Array.isArray(data.missing)) {
        interrupted = true;
        break;
      }
      for (const hash of data.missing) {
        if (typeof hash === 'string' && requested.has(hash)) missing.add(hash);
      }
      lastChecked = chunk[chunk.length - 1] ?? lastChecked;
    }
  } catch {
    throwIfAborted(signal);
    interrupted = true;
    // Bereits vollständig geprüfte frühere Chunks bleiben verwertbar. Nur der
    // unterbrochene und die folgenden Chunks werden im nächsten Sync erneut geprüft.
  }
  const fullRotationCompleted =
    !interrupted && start + scheduled.length >= synced.length;
  if (lastChecked) {
    await withLocalDataOperation(() =>
      fullRotationCompleted
        ? db.meta.delete(MEDIA_REVALIDATION_CURSOR_KEY)
        : db.meta.put({ key: MEDIA_REVALIDATION_CURSOR_KEY, value: lastChecked })
          .then(() => undefined));
  }
  if (missing.size === 0) return { reset: 0, complete: fullRotationCompleted };
  throwIfAborted(signal);

  let reset = 0;
  await withLocalDataOperation(() =>
    db.transaction('rw', db.media, async () => {
      for (const hash of missing) {
        const media = await db.media.get(hash);
        if (!media || media.synced !== 1) continue;
        await db.media.put({ ...media, synced: 0 });
        reset += 1;
      }
    }));
  throwIfAborted(signal);
  return { reset, complete: fullRotationCompleted };
}

/**
 * Lädt alle lokal noch nicht synchronisierten Medien (synced === 0) zum Backend hoch.
 * - Optional zuerst /api/media/exists, um bereits vorhandene Hashes ohne Re-Upload zu markieren.
 * - Pro Blob: POST /api/media/upload mit rohen Bytes + Content-Type + Bearer-Token.
 * - HTTP 200 → synced = 1. 503 (R2 aus) oder Netzwerkfehler → bleibt offen, zählt als failed.
 */
export async function uploadPendingMedia(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ uploaded: number; failed: number }> {
  throwIfAborted(signal);
  const pending = await db.media.where('synced').equals(0).toArray();
  throwIfAborted(signal);
  if (pending.length === 0) return { uploaded: 0, failed: 0 };

  const auth = { Authorization: `Bearer ${token}` };
  let uploaded = 0;
  let failed = 0;

  // Schritt 1 (optional): bereits vorhandene Hashes ermitteln und sofort als synced markieren.
  // In 40er-Chunks: der Server prüft jeden Hash per R2-head() (= 1 Subrequest, Free-Plan-
  // Limit 50/Request) und lehnt größere Listen mit 413 ab.
  const have = new Set<string>();
  try {
    const existsLimit = MAX_PENDING_EXISTS_CHUNKS_PER_SYNC * EXISTS_CHUNK;
    for (let i = 0; i < Math.min(pending.length, existsLimit); i += EXISTS_CHUNK) {
      throwIfAborted(signal);
      const chunk = pending.slice(i, i + EXISTS_CHUNK);
      const res = await fetch(`${baseUrl}/api/media/exists`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: chunk.map((m) => m.hash) }),
        signal,
      });
      throwIfAborted(signal);
      if (!res.ok) break; // exists ist nur eine Optimierung – Rest wird regulär hochgeladen
      const data = (await res.json()) as { have?: string[]; missing?: string[] };
      for (const h of data.have ?? []) have.add(h);
    }
  } catch {
    throwIfAborted(signal);
    // exists ist nur eine Optimierung – bei Fehler einfach alle hochladen versuchen.
  }
  const stillPending: Media[] = [];
  for (const m of pending) {
    throwIfAborted(signal);
    if (have.has(m.hash)) {
      await markSynced(m.hash);
      uploaded += 1;
    } else {
      stillPending.push(m);
    }
  }

  // Schritt 2: Restliche Blobs hochladen.
  for (let index = 0; index < stillPending.length; index++) {
    const m = stillPending[index];
    throwIfAborted(signal);
    try {
      const res = await fetch(`${baseUrl}/api/media/upload`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': m.mime },
        body: m.blob,
        signal,
      });
      throwIfAborted(signal);
      if (res.status === 200) {
        const responseBody = (await res.json().catch(() => ({}))) as { hash?: unknown };
        if (responseBody.hash !== m.hash) {
          // Ein Proxy-/Serverfehler darf niemals einen anderen content-addressierten Blob
          // als erfolgreich markieren; der lokale Datensatz bleibt für einen Retry pending.
          failed += 1;
          continue;
        }
        await markSynced(m.hash);
        uploaded += 1;
      } else if (res.status === 415) {
        // Ein einzelnes ungültiges Altformat darf spätere gültige Bilder nicht blockieren.
        failed += 1;
      } else if (res.status === 413) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        const quotaReached =
          typeof body.error === 'string' && body.error.includes('Speicherlimit');
        if (quotaReached) {
          failed += stillPending.length - index;
          break;
        }
        // Einzelne alte Datei oberhalb der heutigen Grenze überspringen.
        failed += 1;
      } else if (res.status === 409) {
        // MEDIA_DELETE_IN_PROGRESS: Der Server-GC beansprucht genau diese Datei gerade.
        // Transient und dateispezifisch — weder als Fehler zählen (sonst meldet der Sync
        // dauerhaft "konnte nicht synchronisiert werden") noch die restlichen Uploads
        // abbrechen. Der Blob bleibt pending; der nächste Sync-Lauf versucht es erneut.
      } else {
        // Rate-Limit, deaktiviertes R2, Auth- oder Serverfehler gelten für die folgenden
        // Requests voraussichtlich ebenfalls. Abbrechen statt tausende identische Fehler
        // zu erzeugen; alle Blobs bleiben pending und werden später erneut versucht.
        failed += stillPending.length - index;
        break;
      }
    } catch (errorValue) {
      throwIfAborted(signal);
      if (errorValue instanceof LocalDataResetError) throw errorValue;
      // Ein Netzfehler ist kein per-Datei-Problem; Rest dieses Laufs nicht mehr anfragen.
      failed += stillPending.length - index;
      break;
    }
  }

  return { uploaded, failed };
}

export async function garbageCollectRemoteMedia(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ available: boolean; complete: boolean }> {
  throwIfAborted(signal);
  const res = await fetch(`${baseUrl}/api/media/gc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  throwIfAborted(signal);
  if (res.status === 503) return { available: false, complete: false };
  if (!res.ok) throw new Error(`Medienbereinigung fehlgeschlagen (${res.status})`);
  const result = (await res.json().catch(() => ({}))) as { complete?: unknown };
  // Abwärtskompatibel zu einem noch gecachten Client/Worker-Paar: Der frühere
  // Endpunkt erledigte den gesamten Zyklus in einem Request und hatte kein complete-Feld.
  return {
    available: true,
    complete: typeof result.complete === 'boolean' ? result.complete : true,
  };
}

async function markSynced(hash: string): Promise<void> {
  await withLocalDataOperation(async () => {
    const m = await db.media.get(hash);
    if (m) await db.media.put({ ...m, synced: 1 });
  });
}

/**
 * Stellt sicher, dass alle in einem HTML referenzierten flashmedia:HASH-Bilder lokal
 * vorliegen. Fehlende Hashes werden per GET /api/media/HASH (mit Auth) geladen und
 * lokal in db.media abgelegt. Für Cross-Device-Anzeige von Bildern anderer Geräte.
 */
export async function downloadReferencedMedia(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ downloaded: number; pending: number }> {
  throwIfAborted(signal);
  const [notes, noteTypes] = await Promise.all([db.notes.toArray(), db.noteTypes.toArray()]);
  const referenced = referencedMediaHashes(notes, noteTypes);
  const hashes = [...referenced].sort();
  const local = await db.media.bulkGet(hashes);
  const missing = hashes.filter((_, index) => !local[index]);
  if (missing.length === 0) {
    await withLocalDataOperation(() => db.meta.delete(MEDIA_DOWNLOAD_CURSOR_KEY));
    return { downloaded: 0, pending: 0 };
  }

  const auth = { Authorization: `Bearer ${token}` };
  const cursorMeta = await db.meta.get(MEDIA_DOWNLOAD_CURSOR_KEY);
  const cursor = typeof cursorMeta?.value === 'string' ? cursorMeta.value : '';
  const afterCursor = cursor ? missing.findIndex((hash) => hash > cursor) : 0;
  const start = afterCursor >= 0 ? afterCursor : 0;
  const ordered = [...missing.slice(start), ...missing.slice(0, start)];
  const scheduled = ordered.slice(0, MAX_MEDIA_DOWNLOADS_PER_SYNC);
  let downloaded = 0;
  let lastChecked: string | null = null;
  let interrupted = false;

  for (let offset = 0; offset < scheduled.length; offset += MEDIA_DOWNLOAD_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = scheduled.slice(offset, offset + MEDIA_DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(async (hash) => {
      try {
        const res = await fetch(`${baseUrl}/api/media/${hash}`, { headers: auth, signal });
        throwIfAborted(signal);
        if (res.status === 429) return 'stop' as const;
        if (!res.ok) return 'skip' as const; // 404/503 → späterer Zyklus versucht erneut
        const blob = await res.blob();
        throwIfAborted(signal);
        const mime = (res.headers.get('Content-Type') ?? blob.type).toLowerCase();
        if (blob.size === 0 || blob.size > MAX_REMOTE_MEDIA_BYTES || !SAFE_REMOTE_MEDIA_TYPES.has(mime)) {
          return 'skip' as const;
        }
        // Integritätsprüfung: gelieferte Bytes müssen zum angeforderten Hash passen,
        // sonst nicht speichern (verhindert Vergiftung des content-addressierten Stores).
        const actualHash = await sha256Hex(await blob.arrayBuffer());
        throwIfAborted(signal);
        if (actualHash !== hash) return 'skip' as const;
        const { width, height } = await imageDimensions(blob);
        const media: Media = {
          hash,
          blob,
          mime,
          size: blob.size,
          width,
          height,
          createdAt: Date.now(),
          synced: 1, // kam vom Server, gilt als synchronisiert
        };
        // Nur einfügen, wenn nicht zwischenzeitlich vorhanden (Dedup via Primärschlüssel).
        await withLocalDataOperation(async () => {
          if (!(await db.media.get(hash))) await db.media.add(media);
        });
        return 'downloaded' as const;
      } catch (errorValue) {
        throwIfAborted(signal);
        if (errorValue instanceof LocalDataResetError) throw errorValue;
        return 'stop' as const;
      }
    }));
    const stoppedAt = results.indexOf('stop');
    const completedInBatch = stoppedAt >= 0 ? stoppedAt : batch.length;
    for (let index = 0; index < completedInBatch; index++) {
      if (results[index] === 'downloaded') downloaded += 1;
      lastChecked = batch[index];
    }
    if (stoppedAt >= 0) {
      interrupted = true;
      break;
    }
  }

  if (lastChecked) {
    const fullRotationCompleted = !interrupted && scheduled.length === ordered.length;
    await withLocalDataOperation(() =>
      fullRotationCompleted
        ? db.meta.delete(MEDIA_DOWNLOAD_CURSOR_KEY)
        : db.meta.put({ key: MEDIA_DOWNLOAD_CURSOR_KEY, value: lastChecked })
          .then(() => undefined));
  }
  return { downloaded, pending: Math.max(0, missing.length - downloaded) };
}

// Bildmaße aus einem heruntergeladenen Blob ermitteln (best effort).
async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close();
      return dims;
    } catch {
      // ignorieren, Fallback unten
    }
  }
  return { width: 0, height: 0 };
}
