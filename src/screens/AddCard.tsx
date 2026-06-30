import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '../db/db';
import { addNote, updateNote } from '../db/api';
import { mediaUrl, resolveMediaHtml, storeImage } from '../lib/media';
import { renderMarkdown } from '../lib/markdown';

// Findet alle flashmedia:HASH-Referenzen in einem Feldtext (für die Thumbnail-Leiste).
// Tolerant gegenüber Attributen vor src (z. B. <img alt="x" src="flashmedia:…">), wie sie
// aus .apkg-Importen entstehen — sonst wären solche Bilder im Editor unsichtbar/nicht entfernbar.
const FIELD_MEDIA_RE = /<img\b[^>]*?\bsrc=(["'])flashmedia:([a-f0-9]+)\1[^>]*>/gi;

function mediaHashesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FIELD_MEDIA_RE)) out.push(m[2]);
  return out;
}

// Größtes akzeptiertes Eingabebild (vor Kompression) — schützt v. a. Mobile vor OOM beim Dekodieren.
const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;

// Entfernt das <img>-Tag eines bestimmten Hashes aus dem Feldtext (Blob bleibt erhalten).
function removeMediaTag(text: string, hash: string): string {
  const safe = hash.replace(/[^a-f0-9]/gi, ''); // Hash ist Hex; defensiv säubern fürs RegExp
  const re = new RegExp(`<img\\b[^>]*?\\bsrc=(["'])flashmedia:${safe}\\1[^>]*>`, 'gi');
  return text.replace(re, '');
}

export default function AddCard() {
  const { noteId } = useParams<{ noteId?: string }>();
  const isEdit = Boolean(noteId);
  const navigate = useNavigate();

  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const noteTypes = useLiveQuery(() => db.noteTypes.toArray(), []);
  const existingNote = useLiveQuery(() => noteId ? db.notes.get(noteId) : Promise.resolve(undefined), [noteId]) as import('../db/db').Note | undefined;

  const [deckId, setDeckId] = useState('');
  const [noteTypeId, setNoteTypeId] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busyField, setBusyField] = useState<string | null>(null);

  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const caretRefs = useRef<Record<string, number>>({});
  const loadedNoteIdRef = useRef<string | null>(null);

  // Edit-Modus: Note-Daten einladen. Pro noteId genau einmal — aber beim Wechsel
  // /edit/A → /edit/B (gleiche Komponenteninstanz) erneut laden, sonst zeigt/speichert
  // das Formular die Daten der vorherigen Karte (Datenverlust-Risiko).
  useEffect(() => {
    if (!isEdit || !existingNote) return;
    if (loadedNoteIdRef.current === existingNote.id) return;
    setDeckId(existingNote.deckId);
    setNoteTypeId(existingNote.noteTypeId);
    setFields(existingNote.fields);
    loadedNoteIdRef.current = existingNote.id;
  }, [isEdit, existingNote]);

  // Neu-Modus: Defaults setzen
  useEffect(() => {
    if (isEdit) return;
    if (decks && decks.length && !deckId) setDeckId(decks[0].id);
  }, [decks, deckId, isEdit]);
  useEffect(() => {
    if (isEdit) return;
    if (noteTypes && noteTypes.length && !noteTypeId) setNoteTypeId(noteTypes[0].id);
  }, [noteTypes, noteTypeId, isEdit]);

  const nt = useMemo(() => noteTypes?.find((t) => t.id === noteTypeId), [noteTypes, noteTypeId]);

  useEffect(() => {
    if (isEdit) return;
    if (nt) setFields(Object.fromEntries(nt.fields.map((f) => [f, ''])));
  }, [nt, isEdit]);

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
    if (file.size > MAX_IMAGE_INPUT_BYTES) {
      alert('Bild ist zu groß (max. 25 MB).');
      return;
    }
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
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    e.preventDefault();
    const files = dropped.filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      alert('Nur Bilddateien werden unterstützt.');
      return;
    }
    rememberCaret(field);
    for (const f of files) void addImageToField(field, f);
  }

  function onFileChange(field: string, e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const files = picked.filter((f) => f.type.startsWith('image/'));
    if (picked.length > 0 && files.length === 0) alert('Nur Bilddateien werden unterstützt.');
    for (const f of files) void addImageToField(field, f);
    e.target.value = ''; // gleiche Datei erneut wählbar machen
  }

  function removeImage(field: string, hash: string) {
    setFields((prev) => ({ ...prev, [field]: removeMediaTag(prev[field] ?? '', hash) }));
  }

  async function onSave() {
    if (!nt || !deckId) return;
    if (isEdit && noteId) {
      await updateNote(noteId, fields, deckId, noteTypeId);
      setSaved(true);
      setTimeout(() => { setSaved(false); navigate('/browse'); }, 1000);
    } else {
      await addNote({ noteTypeId: nt.id, deckId, fields });
      setFields(Object.fromEntries(nt.fields.map((f) => [f, ''])));
      caretRefs.current = {};
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  }

  return (
    <div>
      <h1 className="screen-title">{isEdit ? 'Karte bearbeiten' : 'Neue Karte'}</h1>
      {isEdit && (
        <button className="back-btn" onClick={() => navigate('/browse')}>← Zurück</button>
      )}

      <div className="field">
        <label className="field-label" htmlFor="ac-deck">Deck</label>
        <select id="ac-deck" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="ac-nt">Notiztyp</label>
        <select id="ac-nt" value={noteTypeId} onChange={(e) => setNoteTypeId(e.target.value)}>
          {noteTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {nt?.kind === 'cloze' && (
        <p className="info" style={{ margin: '0 0 var(--s4)' }}>
          Lückentext-Syntax: <code>{'{{c1::Antwort}}'}</code> oder mit Hinweis{' '}
          <code>{'{{c1::Antwort::Hinweis}}'}</code>.
        </p>
      )}

      <p className="info" style={{ margin: '0 0 var(--s4)' }}>
        Markdown möglich: <code>**fett**</code> · <code>*kursiv*</code> ·{' '}
        <code># Überschrift</code> · <code>- Liste</code> · <code>`Code`</code>
      </p>

      {nt?.fields.map((f) => {
        const hashes = mediaHashesIn(fields[f] ?? '');
        return (
          <div className="field" key={f}>
            <div className="field-head">
              <label className="field-label" htmlFor={`ac-f-${f}`}>{f}</label>
              <button
                type="button"
                className="tint-text"
                disabled={busyField === f}
                onClick={() => fileInputRefs.current[f]?.click()}
                title="Bild aus Datei einfügen"
              >
                {busyField === f ? '…' : '+ Bild'}
              </button>
            </div>
            <textarea
              id={`ac-f-${f}`}
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
            <MarkdownPreview source={fields[f] ?? ''} />
          </div>
        );
      })}

      <button className="primary block" style={{ marginTop: 'var(--s2)' }} disabled={!canSave} onClick={() => void onSave()}>
        {saved ? '✓ Gespeichert' : isEdit ? 'Änderungen speichern' : 'Karte speichern'}
      </button>
    </div>
  );
}

// Live-Vorschau eines Feldes: rendert Markdown→HTML und löst flashmedia-Bilder zu
// Object-URLs auf (wie im Review), damit man beim Erstellen die Formatierung sieht.
function MarkdownPreview({ source }: { source: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let alive = true;
    resolveMediaHtml(renderMarkdown(source)).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [source]);
  if (!source.trim()) return null;
  return (
    <div className="md-preview">
      <span className="md-preview-label">Vorschau</span>
      <div className="md-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
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
