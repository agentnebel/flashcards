export interface ZipSafetyLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxUncompressedBytes: number;
  label: string;
}

export interface ZipInspection {
  entries: number;
  uncompressedBytes: number;
}

interface ZipEntryDescriptor {
  name: string;
  compression: 0 | 8;
  compressedBytes: number;
  uncompressedBytes: number;
  dataStart: number;
  dataEnd: number;
  localStart: number;
}

const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SEARCH_BYTES = 65_557;
const INFLATE_INPUT_CHUNK_BYTES = 8 * 1024;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function inspectZipDirectory(
  bytes: Uint8Array,
  limits: ZipSafetyLimits,
): { inspection: ZipInspection; descriptors: ZipEntryDescriptor[] } {
  if (bytes.byteLength < EOCD_MIN_BYTES) {
    throw new Error(`Ungültiges ${limits.label}-Archiv`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstEocd = Math.max(0, bytes.byteLength - EOCD_MAX_SEARCH_BYTES);
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_BYTES; offset >= firstEocd; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Ungültiges ${limits.label}-Archiv`);

  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + EOCD_MIN_BYTES + commentLength !== bytes.byteLength) {
    throw new Error(`Ungültiger ${limits.label}-ZIP-Abschluss`);
  }

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error(`${limits.label}: ZIP64/mehrteilige Archive werden nicht unterstützt.`);
  }
  if (entries > limits.maxEntries) {
    throw new Error(`${limits.label} enthält zu viele Dateien (max. ${limits.maxEntries}).`);
  }

  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > eocd || directoryEnd > bytes.byteLength) {
    throw new Error(`Ungültiges ${limits.label}-ZIP-Verzeichnis`);
  }

  let total = 0;
  let cursor = directoryOffset;
  const names = new Set<string>();
  const descriptors: ZipEntryDescriptor[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`Ungültiger ${limits.label}-ZIP-Eintrag`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentEntryLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error(`${limits.label}: ZIP64 wird nicht unterstützt.`);
    }
    if ((flags & 1) !== 0) throw new Error(`${limits.label}: Verschlüsselte ZIPs werden nicht unterstützt.`);
    if (compression !== 0 && compression !== 8) {
      throw new Error(`${limits.label}: Nicht unterstützte ZIP-Kompression.`);
    }
    if (uncompressed > limits.maxEntryBytes) {
      throw new Error(`${limits.label} enthält eine zu große Datei.`);
    }

    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentEntryLength;
    if (nextCursor > directoryEnd) throw new Error(`Ungültiger ${limits.label}-ZIP-Eintrag`);
    const centralNameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decoder.decode(centralNameBytes);
    if (names.has(name)) throw new Error(`${limits.label} enthält doppelte Dateinamen.`);
    names.add(name);

    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Ungültiger lokaler ${limits.label}-ZIP-Eintrag`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompression = view.getUint16(localOffset + 8, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const hasDataDescriptor = (flags & 8) !== 0;
    if (
      localFlags !== flags ||
      localCompression !== compression ||
      localNameEnd + localExtraLength > directoryOffset ||
      !sameBytes(centralNameBytes, bytes.subarray(localNameStart, localNameEnd)) ||
      (!hasDataDescriptor &&
        (localCompressed !== compressed || localUncompressed !== uncompressed)) ||
      (hasDataDescriptor &&
        ((localCompressed !== 0 && localCompressed !== compressed) ||
          (localUncompressed !== 0 && localUncompressed !== uncompressed)))
    ) {
      throw new Error(`Widersprüchlicher lokaler ${limits.label}-ZIP-Eintrag`);
    }
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (dataEnd > directoryOffset) {
      throw new Error(`Ungültige ${limits.label}-ZIP-Nutzdaten`);
    }

    total += uncompressed;
    if (total > limits.maxUncompressedBytes) {
      throw new Error(`${limits.label} ist unkomprimiert zu groß.`);
    }
    descriptors.push({
      name,
      compression,
      compressedBytes: compressed,
      uncompressedBytes: uncompressed,
      dataStart,
      dataEnd,
      localStart: localOffset,
    });
    cursor = nextCursor;
  }

  if (cursor !== directoryEnd) throw new Error(`Ungültiges ${limits.label}-ZIP-Verzeichnis`);

  // Ein zentraler Eintrag darf nicht mehrfach auf dieselben lokalen Bytes zeigen. Sonst
  // könnte ein winziges Archiv denselben hochkomprimierten Stream tausendfach expandieren,
  // obwohl die deklarierte Gesamtsumme klein aussieht.
  const orderedRanges = [...descriptors].sort((left, right) => left.localStart - right.localStart);
  for (let index = 1; index < orderedRanges.length; index++) {
    if (orderedRanges[index].localStart < orderedRanges[index - 1].dataEnd) {
      throw new Error(`${limits.label} enthält überlappende ZIP-Einträge.`);
    }
  }

  return {
    inspection: { entries, uncompressedBytes: total },
    descriptors,
  };
}

/**
 * Prüft das zentrale ZIP-Verzeichnis, bevor ein Entpacker Speicher anhand fremder
 * Größenangaben reserviert. ZIP64, verschlüsselte und mehrteilige Archive werden
 * bewusst abgelehnt; die App erzeugt bzw. erwartet nur gewöhnliche ZIP-Dateien.
 */
export function inspectZip(
  bytes: Uint8Array,
  limits: ZipSafetyLimits,
): ZipInspection {
  return inspectZipDirectory(bytes, limits).inspection;
}

/**
 * Entpackt nur genau die im geprüften Verzeichnis beschriebenen Bytes und zählt dabei
 * die TATSÄCHLICH erzeugte Ausgabe. Ein gefälschter kleiner Größenwert kann den Decoder
 * deshalb nicht mehr dazu bringen, einen beliebig großen Deflate-Stream abzuarbeiten.
 */
export async function unzipSafely(
  bytes: Uint8Array,
  limits: ZipSafetyLimits,
): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
  const { descriptors } = inspectZipDirectory(bytes, limits);
  const { Inflate } = await import('fflate');
  const files = Object.create(null) as Record<string, Uint8Array<ArrayBuffer>>;
  let totalActual = 0;

  for (const descriptor of descriptors) {
    if (descriptor.compression === 0) {
      if (descriptor.compressedBytes !== descriptor.uncompressedBytes) {
        throw new Error(`${limits.label}: Tatsächliche ZIP-Größe widerspricht der Größenangabe.`);
      }
      const copy = new Uint8Array(descriptor.compressedBytes);
      copy.set(bytes.subarray(descriptor.dataStart, descriptor.dataEnd));
      files[descriptor.name] = copy;
      totalActual += copy.byteLength;
      continue;
    }

    const output = new Uint8Array(descriptor.uncompressedBytes);
    let actual = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      const nextEntryBytes = actual + chunk.byteLength;
      const nextTotalBytes = totalActual + nextEntryBytes;
      if (
        nextEntryBytes > descriptor.uncompressedBytes ||
        nextEntryBytes > limits.maxEntryBytes ||
        nextTotalBytes > limits.maxUncompressedBytes
      ) {
        throw new Error(`${limits.label}: Tatsächliche ZIP-Größe überschreitet die Größenangabe.`);
      }
      output.set(chunk, actual);
      actual = nextEntryBytes;
      finished = final;
    });

    for (
      let offset = descriptor.dataStart;
      offset < descriptor.dataEnd;
      offset += INFLATE_INPUT_CHUNK_BYTES
    ) {
      const end = Math.min(descriptor.dataEnd, offset + INFLATE_INPUT_CHUNK_BYTES);
      inflater.push(bytes.subarray(offset, end), end === descriptor.dataEnd);
    }
    if (descriptor.compressedBytes === 0) {
      inflater.push(new Uint8Array(0), true);
    }
    if (!finished || actual !== descriptor.uncompressedBytes) {
      throw new Error(`${limits.label}: Tatsächliche ZIP-Größe widerspricht der Größenangabe.`);
    }

    files[descriptor.name] = output;
    totalActual += actual;
  }

  return files;
}
