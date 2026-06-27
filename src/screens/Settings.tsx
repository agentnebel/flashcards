import { useEffect, useState } from 'react';
import { exportBackup, getDesiredRetention, setDesiredRetention } from '../db/api';
import { db } from '../db/db';

export default function Settings() {
  const [retention, setRetention] = useState(0.9);
  const [health, setHealth] = useState<string>('—');
  const [outboxCount, setOutboxCount] = useState(0);

  useEffect(() => {
    getDesiredRetention().then(setRetention);
    db.outbox.count().then(setOutboxCount);
  }, []);

  async function onRetention(v: number) {
    setRetention(v);
    await setDesiredRetention(v);
  }

  async function onExport() {
    const json = await exportBackup();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `flashcards-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function checkServer() {
    setHealth('prüfe…');
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHealth(res.ok ? `OK (${JSON.stringify(data)})` : `Fehler ${res.status}`);
    } catch {
      setHealth('nicht erreichbar (lokal ohne Worker normal)');
    }
  }

  return (
    <div className="stack">
      <section>
        <h3>FSRS</h3>
        <label>Ziel-Retention: {Math.round(retention * 100)} %</label>
        <input
          type="range"
          min={0.8}
          max={0.97}
          step={0.01}
          value={retention}
          onChange={(e) => onRetention(parseFloat(e.target.value))}
        />
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Höher = häufigere Wiederholungen, bessere Behaltensquote.
        </p>
      </section>

      <section>
        <h3>Daten</h3>
        <button onClick={onExport}>JSON-Backup exportieren</button>
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Ausstehende Sync-Änderungen (Outbox): {outboxCount}
        </p>
      </section>

      <section>
        <h3>Konto &amp; Sync <span className="muted" style={{ fontSize: '0.75rem' }}>(Phase 2)</span></h3>
        <button onClick={checkServer}>Server prüfen</button>
        <p className="muted" style={{ fontSize: '0.8rem' }}>Status: {health}</p>
      </section>
    </div>
  );
}
