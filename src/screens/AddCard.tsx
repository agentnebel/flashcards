import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../db/db';
import { addNote } from '../db/api';

export default function AddCard() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const noteTypes = useLiveQuery(() => db.noteTypes.toArray(), []);

  const [deckId, setDeckId] = useState('');
  const [noteTypeId, setNoteTypeId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (decks && decks.length && !deckId) setDeckId(decks[0].id);
  }, [decks, deckId]);
  useEffect(() => {
    if (noteTypes && noteTypes.length && !noteTypeId) setNoteTypeId(noteTypes[0].id);
  }, [noteTypes, noteTypeId]);

  const nt = useMemo(() => noteTypes?.find((t) => t.id === noteTypeId), [noteTypes, noteTypeId]);

  useEffect(() => {
    if (nt) setFields(Object.fromEntries(nt.fields.map((f) => [f, ''])));
  }, [nt]);

  if (!decks || !noteTypes) return <p className="muted">Lädt…</p>;

  const canSave = nt && Object.values(fields).some((v) => v.trim());

  async function onSave() {
    if (!nt || !deckId) return;
    await addNote({ noteTypeId: nt.id, deckId, fields });
    setFields(Object.fromEntries(nt.fields.map((f) => [f, ''])));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div>
      <label>Deck</label>
      <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      <label>Notiztyp</label>
      <select value={noteTypeId} onChange={(e) => setNoteTypeId(e.target.value)}>
        {noteTypes.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>

      {nt?.kind === 'cloze' && (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.75rem' }}>
          Lückentext-Syntax: <code>{'{{c1::Antwort}}'}</code> oder mit Hinweis{' '}
          <code>{'{{c1::Antwort::Hinweis}}'}</code>.
        </p>
      )}

      {nt?.fields.map((f) => (
        <div key={f}>
          <label>{f}</label>
          <textarea
            rows={f === nt.fields[0] && nt.kind === 'cloze' ? 4 : 2}
            value={fields[f] ?? ''}
            onChange={(e) => setFields((prev) => ({ ...prev, [f]: e.target.value }))}
          />
        </div>
      ))}

      <button className="primary" style={{ width: '100%', marginTop: '1.25rem' }} disabled={!canSave} onClick={onSave}>
        {saved ? '✓ Gespeichert' : 'Karte speichern'}
      </button>
    </div>
  );
}
