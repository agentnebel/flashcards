// Medien-Sync-Client gegen das R2-gestützte Backend.
//
// HINWEIS: Diese Funktionen werden von der späteren Haupt-Sync-Schleife aufgerufen
// (eigener Meilenstein) und sind hier bewusst NICHT automatisch verdrahtet. Sie
// kapseln nur den HTTP-Vertrag, damit der Upload-/Download-Pfad bereitsteht.

import { db, type Media } from '../db/db';
import { mediaUrl, sha256Hex } from '../lib/media';

const FLASHMEDIA_RE = /flashmedia:([a-f0-9]+)/g;

/**
 * Lädt alle lokal noch nicht synchronisierten Medien (synced === 0) zum Backend hoch.
 * - Optional zuerst /api/media/exists, um bereits vorhandene Hashes ohne Re-Upload zu markieren.
 * - Pro Blob: POST /api/media/upload mit rohen Bytes + Content-Type + Bearer-Token.
 * - HTTP 200 → synced = 1. 503 (R2 aus) oder Netzwerkfehler → bleibt offen, zählt als failed.
 */
export async function uploadPendingMedia(
  baseUrl: string,
  token: string,
): Promise<{ uploaded: number; failed: number }> {
  const pending = await db.media.where('synced').equals(0).toArray();
  if (pending.length === 0) return { uploaded: 0, failed: 0 };

  const auth = { Authorization: `Bearer ${token}` };
  let uploaded = 0;
  let failed = 0;

  // Schritt 1 (optional): bereits vorhandene Hashes ermitteln und sofort als synced markieren.
  // In 40er-Chunks: der Server prüft jeden Hash per R2-head() (= 1 Subrequest, Free-Plan-
  // Limit 50/Request) und lehnt größere Listen mit 413 ab.
  const EXISTS_CHUNK = 40;
  const have = new Set<string>();
  try {
    for (let i = 0; i < pending.length; i += EXISTS_CHUNK) {
      const chunk = pending.slice(i, i + EXISTS_CHUNK);
      const res = await fetch(`${baseUrl}/api/media/exists`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: chunk.map((m) => m.hash) }),
      });
      if (!res.ok) break; // exists ist nur eine Optimierung – Rest wird regulär hochgeladen
      const data = (await res.json()) as { have?: string[]; missing?: string[] };
      for (const h of data.have ?? []) have.add(h);
    }
  } catch {
    // exists ist nur eine Optimierung – bei Fehler einfach alle hochladen versuchen.
  }
  const stillPending: Media[] = [];
  for (const m of pending) {
    if (have.has(m.hash)) {
      await markSynced(m.hash);
      uploaded += 1;
    } else {
      stillPending.push(m);
    }
  }

  // Schritt 2: Restliche Blobs hochladen.
  for (const m of stillPending) {
    try {
      const res = await fetch(`${baseUrl}/api/media/upload`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': m.mime },
        body: m.blob,
      });
      if (res.status === 200) {
        await markSynced(m.hash);
        uploaded += 1;
      } else {
        // 503 (R2 deaktiviert) o. Ä. → offen lassen, später erneut versuchen.
        failed += 1;
      }
    } catch {
      // Netzwerkfehler → offen lassen.
      failed += 1;
    }
  }

  return { uploaded, failed };
}

async function markSynced(hash: string): Promise<void> {
  const m = await db.media.get(hash);
  if (m) await db.media.put({ ...m, synced: 1 });
}

/**
 * Stellt sicher, dass alle in einem HTML referenzierten flashmedia:HASH-Bilder lokal
 * vorliegen. Fehlende Hashes werden per GET /api/media/HASH (mit Auth) geladen und
 * lokal in db.media abgelegt. Für Cross-Device-Anzeige von Bildern anderer Geräte.
 */
export async function ensureMediaForHtml(baseUrl: string, token: string, html: string): Promise<void> {
  if (!html) return;
  const hashes = new Set<string>();
  for (const m of html.matchAll(FLASHMEDIA_RE)) hashes.add(m[1]);
  if (hashes.size === 0) return;

  const auth = { Authorization: `Bearer ${token}` };

  await Promise.all(
    [...hashes].map(async (hash) => {
      // Bereits lokal vorhanden? (mediaUrl prüft db.media)
      if (await mediaUrl(hash)) return;
      try {
        const res = await fetch(`${baseUrl}/api/media/${hash}`, { headers: auth });
        if (!res.ok) return; // 404/503 → nichts zu tun
        const blob = await res.blob();
        // Integritätsprüfung: gelieferte Bytes müssen zum angeforderten Hash passen,
        // sonst nicht speichern (verhindert Vergiftung des content-addressierten Stores).
        const actualHash = await sha256Hex(await blob.arrayBuffer());
        if (actualHash !== hash) return;
        const mime = res.headers.get('Content-Type') ?? blob.type ?? 'image/webp';
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
        if (!(await db.media.get(hash))) await db.media.add(media);
      } catch {
        // Netzwerkfehler → still ignorieren, späterer Sync-Lauf versucht es erneut.
      }
    }),
  );
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
