import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addNote, gcOrphanedMedia } from '../db/api';
import { db, type Media, type NoteType } from '../db/db';

const mocks = vi.hoisted(() => ({ storeImage: vi.fn() }));

vi.mock('../lib/media', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/media')>(),
  storeImage: mocks.storeImage,
}));

import AddCard from './AddCard';

const { Blob: NodeBlob } = await vi.importActual<{ Blob: typeof Blob }>('node:buffer');

const noteType: NoteType = {
  id: 'basic',
  name: 'Einfach',
  kind: 'standard',
  fields: ['Front', 'Back'],
  templates: [{ name: 'Karte', qfmt: '{{Front}}', afmt: '{{Back}}' }],
  css: '',
  updatedAt: 1,
};
const hash = 'a'.repeat(64);
const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let router: ReturnType<typeof createMemoryRouter> | undefined;

// Dexie-LiveQueries und Browser-Events über echte React-Updates abwarten.
async function waitForScreen(check: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
  });
}

function saveButton(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('button.primary');
  if (!button) throw new Error('Speichern-Button fehlt');
  return button;
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.storeImage.mockReset();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  // jsdom besitzt keine Object-URLs; die eigentliche Medienauflösung bleibt aktiv.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(): string { return 'blob:http://localhost/draft-image'; }
    static revokeObjectURL(): void {}
  });
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
  await db.decks.add({ id: 'deck', name: 'Deck', parentId: null, newPerDay: 20, updatedAt: 1 });
  await db.noteTypes.add(noteType);
  mocks.storeImage.mockImplementation(async () => {
    // Native Node-Blobs überstehen structuredClone in fake-indexeddb bytegetreu;
    // das bildet das Browser-Verhalten ab, das jsdom-Blobs hier nicht liefern.
    const image: Media = {
      hash,
      blob: new NodeBlob([imageBytes], { type: 'image/png' }),
      mime: 'image/png',
      size: imageBytes.byteLength,
      width: 80,
      height: 40,
      createdAt: 123,
      synced: 0,
    };
    await db.media.put(image);
    return hash;
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  router?.dispose();
  host?.remove();
  root = undefined;
  router = undefined;
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Entwurfsbilder im Kartenformular', () => {
  it.each(['neu', 'bearbeiten'] as const)(
    'rettet das eingefügte Bild nach einer Bereinigung aus einem anderen Tab: %s',
    async (mode) => {
      let existingNoteId: string | undefined;
      if (mode === 'bearbeiten') {
        await addNote({ deckId: 'deck', noteTypeId: 'basic', fields: { Front: 'Vorher', Back: 'Antwort' } });
        existingNoteId = (await db.notes.toCollection().first())!.id;
      }
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      router = createMemoryRouter([
        { path: '/app/add', element: createElement(AddCard) },
        { path: '/app/edit/:noteId', element: createElement(AddCard) },
        { path: '/app/browse', element: createElement('p', null, 'Kartenübersicht') },
      ], {
        initialEntries: [existingNoteId ? `/app/edit/${existingNoteId}` : '/app/add'],
      });
      await act(async () => root?.render(createElement(RouterProvider, { router: router! })));
      await waitForScreen(() => {
        const front = host?.querySelector<HTMLTextAreaElement>('#ac-f-Front');
        expect(front).not.toBeNull();
        if (mode === 'bearbeiten') expect(front?.value).toBe('Vorher');
      });

      const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File([imageBytes], 'draft.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
      await waitForScreen(() => {
        expect(host?.querySelector<HTMLTextAreaElement>('#ac-f-Front')?.value).toContain(`flashmedia:${hash}`);
        expect(saveButton().disabled).toBe(false);
      });
      expect(mocks.storeImage).toHaveBeenCalledWith(file);

      // Der zweite Tab sieht denselben IndexedDB-Bestand, aber nicht den React-Entwurf.
      expect(await gcOrphanedMedia()).toBe(1);
      expect(await db.media.get(hash)).toBeUndefined();
      await act(async () => saveButton().click());
      await waitForScreen(() => {
        expect(host?.textContent).toContain(mode === 'neu' ? 'Gespeichert' : 'Kartenübersicht');
      });

      const notes = await db.notes.toArray();
      expect(notes).toHaveLength(1);
      expect(notes[0].fields.Front).toContain(`flashmedia:${hash}`);
      if (existingNoteId) expect(notes[0].id).toBe(existingNoteId);
      expect(await db.cards.where('noteId').equals(notes[0].id).count()).toBe(1);
      const restored = await db.media.get(hash);
      expect(restored).toMatchObject({
        hash, mime: 'image/png', size: imageBytes.byteLength,
        width: 80, height: 40, createdAt: 123, synced: 0,
      });
      expect(new Uint8Array(await restored!.blob.arrayBuffer())).toEqual(imageBytes);
      expect(await gcOrphanedMedia()).toBe(0);
      expect(window.alert).not.toHaveBeenCalled();
    },
  );
});
