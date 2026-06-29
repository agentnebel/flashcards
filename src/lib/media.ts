import { db, type Media } from '../db/db';

// Eingebettetes Schema in den Notiz-Feldern: <img src="flashmedia:HASH">.
// Beim Rendern wird flashmedia:HASH in eine Object-URL des lokal gespeicherten Blobs aufgelöst.
export const MEDIA_SCHEME = 'flashmedia:';

const MAX_SIDE = 1600; // längste Kante nach Skalierung
const TARGET_MAX_BYTES = 1.5 * 1024 * 1024; // Zielgröße ~1,5 MB

// ---- Bild laden ----

async function loadBitmap(input: Blob): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void }> {
  // Bevorzugt createImageBitmap (schnell, kein DOM); Fallback auf <img>.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(input);
      return {
        width: bmp.width,
        height: bmp.height,
        draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
        close: () => bmp.close(),
      };
    } catch {
      // auf <img>-Pfad zurückfallen
    }
  }
  const url = URL.createObjectURL(input);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
      el.src = url;
    });
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      close: () => {},
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
}

/**
 * Komprimiert ein Bild: skaliert die längste Kante auf ≤ MAX_SIDE (kein Hochskalieren),
 * exportiert als image/webp (~0.85), Fallback image/jpeg. Reduziert die Qualität,
 * bis das Ergebnis unter ~1,5 MB liegt.
 */
export async function compressImage(
  input: Blob,
): Promise<{ blob: Blob; mime: string; width: number; height: number }> {
  const src = await loadBitmap(input);
  try {
    const longest = Math.max(src.width, src.height) || 1;
    const scale = Math.min(1, MAX_SIDE / longest);
    const width = Math.max(1, Math.round(src.width * scale));
    const height = Math.max(1, Math.round(src.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas-2D-Kontext nicht verfügbar');
    src.draw(ctx, width, height);

    // WebP-Unterstützung prüfen (manche Browser liefern image/png als Fallback).
    let mime = 'image/webp';
    const probe = await canvasToBlob(canvas, mime, 0.85);
    if (!probe || probe.type !== 'image/webp') {
      mime = 'image/jpeg';
    }

    let quality = 0.85;
    let blob = await canvasToBlob(canvas, mime, quality);
    // Qualität schrittweise senken, bis Zielgröße erreicht ist.
    while (blob && blob.size > TARGET_MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, mime, quality);
    }
    if (!blob) throw new Error('Bild konnte nicht komprimiert werden');
    return { blob, mime, width, height };
  } finally {
    src.close();
  }
}

// ---- Hashing ----

/** SHA-256 → lowercase hex. Muss bytegleich mit dem Backend hashen. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---- Speichern ----

/**
 * Komprimiert das Eingabebild, hasht die komprimierten Bytes und legt es (dedupliziert)
 * in db.media ab. Schreibt NICHT in die normale Outbox – Medien-Sync läuft separat.
 * Gibt den Hash zurück (für das <img src="flashmedia:HASH">-Tag).
 */
const MAX_GIF_BYTES = 8 * 1024 * 1024; // kleine GIFs unverändert behalten

export async function storeImage(input: Blob): Promise<string> {
  let blob: Blob;
  let mime: string;
  let width: number;
  let height: number;
  // Animierte GIFs NICHT über Canvas neu rendern (würde sie auf den ersten Frame plätten).
  // Kleine GIFs unverändert speichern; größere fallen auf die normale Kompression zurück.
  if (input.type === 'image/gif' && input.size <= MAX_GIF_BYTES) {
    blob = input;
    mime = 'image/gif';
    ({ width, height } = await blobDimensions(input));
  } else {
    ({ blob, mime, width, height } = await compressImage(input));
  }
  const buf = await blob.arrayBuffer();
  const hash = await sha256Hex(buf);

  const existing = await db.media.get(hash);
  if (!existing) {
    const media: Media = {
      hash,
      blob,
      mime,
      size: blob.size,
      width,
      height,
      createdAt: Date.now(),
      usn: -1,
      synced: 0,
    };
    await db.media.add(media);
  }
  return hash;
}

async function blobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(blob);
      const d = { width: b.width, height: b.height };
      b.close();
      return d;
    } catch {
      /* ignore */
    }
  }
  return { width: 0, height: 0 };
}

// ---- Object-URL-Cache & Auflösung ----

// Begrenzter LRU-Cache: ohne Obergrenze würde jede je gerenderte Object-URL den Blob
// für die gesamte Seitenlebensdauer im Speicher halten (Leak bei langen Review-Sessions).
const URL_CACHE_MAX = 120;
const urlCache = new Map<string, string>();

function cacheTouch(hash: string, url: string): void {
  urlCache.delete(hash);
  urlCache.set(hash, url); // ans Ende (jüngste Nutzung)
  while (urlCache.size > URL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const stale = urlCache.get(oldest);
    urlCache.delete(oldest);
    if (stale) URL.revokeObjectURL(stale); // bereits gerenderte <img> bleiben sichtbar; nur neue Loads betroffen
  }
}

/** Liefert eine (gecachte) Object-URL für den Blob zum Hash, oder null wenn nicht lokal vorhanden. */
export async function mediaUrl(hash: string): Promise<string | null> {
  const cached = urlCache.get(hash);
  if (cached) {
    cacheTouch(hash, cached);
    return cached;
  }
  const media = await db.media.get(hash);
  if (!media) return null;
  const url = URL.createObjectURL(media.blob);
  cacheTouch(hash, url);
  return url;
}

const FLASHMEDIA_SRC_RE = /src=(["'])flashmedia:([a-f0-9]+)\1/g;

/**
 * Ersetzt jedes src="flashmedia:HASH" durch eine Object-URL des lokalen Blobs.
 * Fehlt ein Hash lokal, bleibt ein dezenter Platzhalter stehen (alt-Hinweis),
 * statt ein kaputtes Bild zu zeigen.
 */
export async function resolveMediaHtml(html: string): Promise<string> {
  if (!html || html.indexOf(MEDIA_SCHEME) === -1) return html;

  // Alle referenzierten Hashes einsammeln und parallel auflösen.
  const hashes = new Set<string>();
  for (const m of html.matchAll(FLASHMEDIA_SRC_RE)) hashes.add(m[2]);

  const urls = new Map<string, string | null>();
  await Promise.all(
    [...hashes].map(async (h) => {
      urls.set(h, await mediaUrl(h));
    }),
  );

  return html.replace(FLASHMEDIA_SRC_RE, (_all, _q: string, hash: string) => {
    const url = urls.get(hash);
    if (url) return `src="${url}"`;
    // Nicht lokal vorhanden (z. B. von anderem Gerät, noch nicht gesynct).
    return `src="" alt="Bild lokal nicht verfügbar" data-flashmedia="${hash}"`;
  });
}
