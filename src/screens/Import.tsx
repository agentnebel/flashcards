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

  useEffect(() => {
    if (decks?.length && !deckId) setDeckId(decks[0].id);
  }, [decks, deckId]);

  if (!decks || !noteTypes) return <p className="muted">Lädt…</p>;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 className="screen-title" style={{ marginBottom: 'var(--s5)' }}>Importieren</h1>
        <Link to="/settings" className="tint-text">‹ Einstellungen</Link>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="imp-deck">Ziel-Deck</label>
        <select id="imp-deck" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      <ApkgSection deckId={deckId} />
      <CsvSection deckId={deckId} noteTypes={noteTypes} />
    </div>
  );
}

function ApkgSection({ deckId }: { deckId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !deckId) return;
    setBusy(true);
    setResult(null);
    setWarnings([]);
    try {
      const { importApkg } = await import('../lib/apkg');
      const r = await importApkg(file, deckId);
      setResult(`${r.notes} Notizen, ${r.cards} Karten, ${r.noteTypes} Notiztypen, ${r.media} Medien importiert.`);
      setWarnings(r.warnings);
    } catch (err) {
      setResult('Fehler: ' + ((err as Error).message || 'Import fehlgeschlagen'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <h2 className="section-head">Anki-Deck (.apkg)</h2>
      <div className="group" style={{ padding: 'var(--s4)' }}>
        <p className="info" style={{ marginTop: 0 }}>
          Importiert Notizen, Notiztypen und Bilder. Karten starten als „neu". Tipp: ältere
          .apkg-Exporte (ohne „.anki21b") funktionieren am besten.
        </p>
        <input type="file" accept=".apkg,.colpkg" disabled={busy} onChange={onFile} />
        {busy && <p className="info" style={{ marginBottom: 0 }}>Importiere… (kann bei großen Decks dauern)</p>}
        {result && (
          <p className={`feedback ${result.startsWith('Fehler') ? 'err' : 'ok'}`} style={{ marginBottom: 0 }}>
            {result}
          </p>
        )}
        {warnings.map((w, i) => (
          <p key={i} className="feedback warn" style={{ marginBottom: 0 }}>⚠ {w}</p>
        ))}
      </div>
    </div>
  );
}

function CsvSection({
  deckId,
  noteTypes,
}: {
  deckId: string;
  noteTypes: { id: string; name: string; fields: string[] }[];
}) {
  const [noteTypeId, setNoteTypeId] = useState('');
  const [text, setText] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [fieldMap, setFieldMap] = useState<number[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (noteTypes.length && !noteTypeId) setNoteTypeId(noteTypes[0].id);
  }, [noteTypes, noteTypeId]);

  const nt = useMemo(() => noteTypes.find((t) => t.id === noteTypeId), [noteTypes, noteTypeId]);
  const parsed = useMemo(() => (text.trim() ? parseCsv(text) : null), [text]);
  const colCount = useMemo(
    () => (parsed ? parsed.rows.reduce((m, r) => Math.max(m, r.length), 0) : 0),
    [parsed],
  );

  useEffect(() => {
    if (nt) setFieldMap(nt.fields.map((_, i) => (i < colCount ? i : -1)));
  }, [nt, colCount]);

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
    <div className="section">
      <h2 className="section-head">CSV / TSV</h2>
      <div className="group" style={{ padding: 'var(--s4)' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="csv-file">Datei</label>
          <input id="csv-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={onFile} />
          <p className="info" style={{ margin: 'var(--s3) 0 var(--s2)' }}>…oder Text direkt einfügen:</p>
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
          <div className="stack" style={{ marginTop: 'var(--s4)' }}>
            <p className="info" style={{ margin: 0 }}>
              Erkannt: Trennzeichen <code>{parsed.delimiter === '\t' ? 'Tab' : parsed.delimiter}</code> ·{' '}
              {colCount} Spalten · {dataCount} Datenzeile(n)
            </p>

            <label className="row" style={{ gap: 'var(--s2)' }}>
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
              />
              Erste Zeile ist Kopfzeile
            </label>

            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="csv-nt">Notiztyp</label>
              <select id="csv-nt" value={noteTypeId} onChange={(e) => setNoteTypeId(e.target.value)}>
                {noteTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">Spalten-Zuordnung</span>
              {nt?.fields.map((f, idx) => (
                <div key={f} className="row" style={{ gap: 'var(--s2)', marginBottom: 'var(--s2)' }}>
                  <span style={{ minWidth: '40%' }}>{f}</span>
                  <select
                    aria-label={`Spalte für ${f}`}
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
              <div className="field" style={{ marginBottom: 0 }}>
                <span className="field-label">Vorschau</span>
                <div className="table-scroll">
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
              </div>
            )}

            <button className="primary block" disabled={busy || dataCount === 0} onClick={onImport}>
              {busy ? 'Importiere…' : `${dataCount} Karte(n) importieren`}
            </button>
          </div>
        )}

        {result && (
          <p className={`feedback ${result.startsWith('Fehler') ? 'err' : 'ok'}`} style={{ marginBottom: 0, marginTop: 'var(--s3)' }}>
            {result}
          </p>
        )}
      </div>
    </div>
  );
}
