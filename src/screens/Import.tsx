import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db/db';
import { importNotes } from '../db/api';
import { parseCsv } from '../lib/csv';

export default function Import() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const noteTypes = useLiveQuery(() => db.noteTypes.toArray(), []);

  const [deckId, setDeckId] = useState('');
  const [noteTypeId, setNoteTypeId] = useState('');
  const [text, setText] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [fieldMap, setFieldMap] = useState<number[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (decks?.length && !deckId) setDeckId(decks[0].id);
  }, [decks, deckId]);
  useEffect(() => {
    if (noteTypes?.length && !noteTypeId) setNoteTypeId(noteTypes[0].id);
  }, [noteTypes, noteTypeId]);

  const nt = useMemo(() => noteTypes?.find((t) => t.id === noteTypeId), [noteTypes, noteTypeId]);
  const parsed = useMemo(() => (text.trim() ? parseCsv(text) : null), [text]);
  const colCount = useMemo(
    () => (parsed ? parsed.rows.reduce((m, r) => Math.max(m, r.length), 0) : 0),
    [parsed],
  );

  // Standard-Mapping: Feld i → Spalte i.
  useEffect(() => {
    if (nt) setFieldMap(nt.fields.map((_, i) => (i < colCount ? i : -1)));
  }, [nt, colCount]);

  if (!decks || !noteTypes) return <p className="muted">Lädt…</p>;

  const headerRow = parsed && hasHeader ? parsed.rows[0] : null;
  const previewRows = parsed ? parsed.rows.slice(hasHeader ? 1 : 0, hasHeader ? 4 : 3) : [];
  const dataCount = parsed ? parsed.rows.length - (hasHeader ? 1 : 0) : 0;
  const colLabel = (i: number) => headerRow?.[i]?.trim() || `Spalte ${i + 1}`;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    setResult(null);
    e.target.value = '';
  }

  async function onImport() {
    if (!nt || !deckId || !parsed) return;
    setBusy(true);
    setResult(null);
    try {
      const n = await importNotes({ deckId, noteTypeId, rows: parsed.rows, fieldMap, hasHeader });
      setResult(`${n} Karte(n) importiert.`);
      setText('');
    } catch (err) {
      setResult('Fehler: ' + ((err as Error).message || 'Import fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>CSV / TSV importieren</h3>
        <Link to="/settings" className="muted">‹ Einstellungen</Link>
      </div>

      <div>
        <label>Datei</label>
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={onFile} />
        <p className="muted" style={{ fontSize: '0.8rem' }}>…oder Text direkt einfügen:</p>
        <textarea
          rows={4}
          placeholder={'Vorderseite,Rückseite\nBonjour,Hallo'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
      </div>

      {parsed && (
        <>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Erkannt: Trennzeichen{' '}
            <code>{parsed.delimiter === '\t' ? 'Tab' : parsed.delimiter}</code> · {colCount} Spalten ·{' '}
            {dataCount} Datenzeile(n)
          </p>

          <label className="row" style={{ gap: '0.5rem' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
            />
            Erste Zeile ist Kopfzeile
          </label>

          <div>
            <label>Deck</label>
            <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Notiztyp</label>
            <select value={noteTypeId} onChange={(e) => setNoteTypeId(e.target.value)}>
              {noteTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label>Spalten-Zuordnung</label>
            {nt?.fields.map((f, idx) => (
              <div key={f} className="row" style={{ gap: '0.5rem', marginBottom: '0.4rem' }}>
                <span style={{ minWidth: '40%' }}>{f}</span>
                <select
                  value={fieldMap[idx] ?? -1}
                  onChange={(e) =>
                    setFieldMap((m) => m.map((v, i) => (i === idx ? parseInt(e.target.value, 10) : v)))
                  }
                >
                  <option value={-1}>(leer)</option>
                  {Array.from({ length: colCount }, (_, c) => (
                    <option key={c} value={c}>{colLabel(c)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {previewRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <label>Vorschau</label>
              <table className="preview-table">
                <tbody>
                  {previewRows.map((r, ri) => (
                    <tr key={ri}>
                      {Array.from({ length: colCount }, (_, c) => (
                        <td key={c}>{r[c] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="primary" disabled={busy || dataCount === 0} onClick={onImport}>
            {busy ? 'Importiere…' : `${dataCount} Karte(n) importieren`}
          </button>
        </>
      )}

      {result && (
        <p style={{ fontSize: '0.9rem', color: result.startsWith('Fehler') ? 'var(--again)' : 'var(--good)' }}>
          {result}
        </p>
      )}
    </div>
  );
}
