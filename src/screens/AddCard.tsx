import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import { db } from '../db/db';
import { addNote } from '../db/api';
import { mediaUrl, storeImage } from '../lib/media';

// Findet alle flashmedia:HASH-Referenzen in einem Feldtext (für die Thumbnail-Leiste).
const FIELD_MEDIA_RE = /<img\s+src=(["'])flashmedia:([a-f0-9]+)\1[^>]*>/g;

function mediaHashesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FIELD_MEDIA_RE)) out.push(m[2]);
  return out;
}

// Entfernt das <img>-Tag eines bestimmten Hashes aus dem Feldtext (Blob bleibt erhalten).
function removeMediaTag(text: string, hash: string): string {
  const re = new RegExp(`<img\\s+src=(["'])flashmedia:${hash}\\1[^>]*>`, 'g');
  return text.replace(re, '');
}

export default function AddCard() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const noteTypes = useLiveQuery(() => db.noteTypes.toArray(), []);

  const [deckId, setDeckId] = useState('');
  const [noteTypeId, setNoteTypeId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busyField, setBusyField] = useState<string | null>(null);

  // Refs auf die Textareas, um die aktuelle Caret-Position zu lesen.
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Versteckte File-Inputs je Feld.
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Zuletzt bekannte Caret-Position je Feld (für Paste/Insert).
  const caretRefs = useRef<Record<string, number>>({});

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

  // Fügt ein <img>-Tag an der gemerkten Caret-Position ein (oder hängt es an).
  function insertTagAtCaret(field: string, tag: string) {
    setFields((prev) => {
      const current = prev[field] ?? '';
      const caret = caretRefs.current[field];
      const pos = typeof caret === 'number' && caret >= 0 && caret <= current.length ? caret : current.length;
      const next = current.slice(0, pos) + tag + current.slice(pos);
      caretRefs.current[field] = pos + tag.length;
      return { ...prev, [field]: next };
    });
  }

  // Komprimiert + speichert ein Bild und fügt das flashmedia-Tag ein.
  async function addImageToField(field: string, file: Blob) {
    setBusyField(field);
    try {
      const hash = await storeImage(file);
      insertTagAtCaret(field, `<img src="flashmedia:${hash}">`);
    } catch (err) {
      console.error('Bild konnte nicht gespeichert werden', err);
      alert('Bild konnte nicht verarbeitet werden.');
    } finally {
      setBusyField(null);
    }
  }

  function rememberCaret(field: string) {
    const el = textareaRefs.current[field];
    if (el) caretRefs.current[field] = el.selectionStart ?? el.value.length;
  }

  function onPaste(field: string, e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          rememberCaret(field);
          void addImageToField(field, file);
          return;
        }
      }
    }
  }

  function onDrop(field: string, e: DragEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    rememberCaret(field);
    for (const f of files) void addImageToField(field, f);
  }

  function onFileChange(field: string, e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    for (const f of files) void addImageToField(field, f);
    e.target.value = ''; // gleiche Datei erneut wählbar machen
  }

  function removeImage(field: string, hash: string) {
    setFields((prev) => ({ ...prev, [field]: removeMediaTag(prev[field] ?? '', hash) }));
  }

  async function onSave() {
    if (!nt || !deckId) return;
    await addNote({ noteTypeId: nt.id, deckId, fields });
    setFields(Object.fromEntries(nt.fields.map((f) => [f, ''])));
    caretRefs.current = {};
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

      {nt?.fields.map((f) => {
        const hashes = mediaHashesIn(fields[f] ?? '');
        return (
          <div key={f}>
            <div className="field-head">
              <label>{f}</label>
              <button
                type="button"
                className="img-btn"
                disabled={busyField === f}
                onClick={() => fileInputRefs.current[f]?.click()}
                title="Bild aus Datei einfügen"
              >
                {busyField === f ? '…' : '📎 Bild'}
              </button>
            </div>
            <textarea
              ref={(el) => { textareaRefs.current[f] = el; }}
              rows={f === nt.fields[0] && nt.kind === 'cloze' ? 4 : 2}
              value={fields[f] ?? ''}
              onChange={(e) => setFields((prev) => ({ ...prev, [f]: e.target.value }))}
              onSelect={() => rememberCaret(f)}
              onKeyUp={() => rememberCaret(f)}
              onClick={() => rememberCaret(f)}
              onBlur={() => rememberCaret(f)}
              onPaste={(e) => onPaste(f, e)}
              onDrop={(e) => onDrop(f, e)}
              onDragOver={(e) => e.preventDefault()}
            />
            <input
              ref={(el) => { fileInputRefs.current[f] = el; }}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => onFileChange(f, e)}
            />
            {hashes.length > 0 && (
              <div className="thumb-strip">
                {hashes.map((h, i) => (
                  <Thumb key={`${h}-${i}`} hash={h} onRemove={() => removeImage(f, h)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <button className="primary" style={{ width: '100%', marginTop: '1.25rem' }} disabled={!canSave} onClick={onSave}>
        {saved ? '✓ Gespeichert' : 'Karte speichern'}
      </button>
    </div>
  );
}

// Kleine Thumbnail-Vorschau, die die Object-URL des Hashes lädt.
function Thumb({ hash, onRemove }: { hash: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    mediaUrl(hash).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [hash]);
  return (
    <div className="thumb">
      {url ? <img src={url} alt="" /> : <div className="thumb-ph" />}
      <button type="button" className="thumb-x" onClick={onRemove} title="Bild entfernen">×</button>
    </div>
  );
}
