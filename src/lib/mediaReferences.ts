import type { Note, NoteType } from '../db/db';

// Dieselben Inhaltsquellen für Import, lokale Bereinigung und Medien-Sync verwenden:
// Ein Bild kann zu einem Notizfeld oder zu einer gemeinsam verwendeten Vorlage gehören.
export function referencedMediaHashes(
  notes: readonly Pick<Note, 'fields'>[],
  noteTypes: readonly Pick<NoteType, 'templates' | 'css'>[] = [],
): Set<string> {
  const hashes = new Set<string>();
  const collect = (source: string | undefined): void => {
    if (typeof source !== 'string') return;
    for (const match of source.matchAll(/flashmedia:([a-f0-9]{64})(?![a-f0-9])/g)) {
      hashes.add(match[1]);
    }
  };

  for (const note of notes) {
    for (const value of Object.values(note.fields ?? {})) collect(value);
  }
  for (const noteType of noteTypes) {
    for (const template of noteType.templates ?? []) {
      collect(template.qfmt);
      collect(template.afmt);
    }
    collect(noteType.css);
  }
  return hashes;
}
