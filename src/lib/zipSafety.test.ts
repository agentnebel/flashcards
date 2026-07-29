import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inspectZip, unzipSafely } from './zipSafety';

const limits = {
  maxEntries: 3,
  maxEntryBytes: 1024,
  maxUncompressedBytes: 1536,
  label: 'Test',
};

describe('inspectZip', () => {
  it('akzeptiert ein kleines gewöhnliches ZIP und summiert deklarierte Größen', () => {
    const archive = zipSync({
      'a.txt': strToU8('abc'),
      'b.txt': strToU8('12345'),
    });

    expect(inspectZip(archive, limits)).toEqual({ entries: 2, uncompressedBytes: 8 });
  });

  it('entpackt ein geprüftes gewöhnliches ZIP vollständig', async () => {
    const archive = zipSync({
      'a.txt': strToU8('abc'),
      'b.txt': strToU8('12345'),
    });

    const entries = await unzipSafely(archive, limits);

    expect(new TextDecoder().decode(entries['a.txt'])).toBe('abc');
    expect(new TextDecoder().decode(entries['b.txt'])).toBe('12345');
  });

  it('stoppt hoch komprimierbare Archive vor dem Entpacken am Gesamtlimit', () => {
    const archive = zipSync({ 'bomb.txt': strToU8('x'.repeat(2_000)) }, { level: 9 });

    expect(() => inspectZip(archive, limits)).toThrow(/zu große Datei|unkomprimiert zu groß/);
  });

  it('lehnt doppelte bzw. beschädigte zentrale Einträge ab', () => {
    const archive = zipSync({ 'a.txt': strToU8('abc') });
    const damaged = new Uint8Array(archive);
    const central = damaged.findIndex((_, index) =>
      damaged[index] === 0x50 &&
      damaged[index + 1] === 0x4b &&
      damaged[index + 2] === 0x01 &&
      damaged[index + 3] === 0x02);
    damaged[central] = 0;

    expect(() => inspectZip(damaged, limits)).toThrow(/Ungültiger Test-ZIP-Eintrag/);
  });

  it('bricht ab, wenn lokale und zentrale Größen gemeinsam nach unten gefälscht wurden', async () => {
    const archive = zipSync(
      { 'bomb.txt': strToU8('x'.repeat(2 * 1024 * 1024)) },
      { level: 9 },
    );
    const local = archive.findIndex((_, index) =>
      archive[index] === 0x50 &&
      archive[index + 1] === 0x4b &&
      archive[index + 2] === 0x03 &&
      archive[index + 3] === 0x04);
    const central = archive.findIndex((_, index) =>
      archive[index] === 0x50 &&
      archive[index + 1] === 0x4b &&
      archive[index + 2] === 0x01 &&
      archive[index + 3] === 0x02);
    expect(local).toBeGreaterThanOrEqual(0);
    expect(central).toBeGreaterThanOrEqual(0);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    view.setUint32(local + 22, 1, true);
    view.setUint32(central + 24, 1, true);

    // Der reine Metadaten-Pass kann die Lüge nicht erkennen; der bounded Decoder muss
    // nach dem ersten tatsächlich erzeugten Output-Chunk abbrechen.
    expect(inspectZip(archive, limits)).toEqual({ entries: 1, uncompressedBytes: 1 });
    await expect(unzipSafely(archive, limits)).rejects.toThrow(/Tatsächliche ZIP-Größe/);
  });
});
