import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { exportBackup, getDesiredRetention, setDesiredRetention } from '../db/api';
import { db } from '../db/db';
import {
  getSyncState,
  loadLastSyncAt,
  login,
  logout,
  register,
  subscribeSync,
  sync,
  type Auth,
} from '../sync/engine';

function useSync() {
  return useSyncExternalStore(subscribeSync, getSyncState);
}

function fmtTime(ts: number | null): string {
  if (!ts) return 'nie';
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export default function Settings() {
  const [retention, setRetention] = useState(0.9);
  const auth = useLiveQuery(() => db.meta.get('auth'), [])?.value as Auth | undefined;
  const outboxCount = useLiveQuery(() => db.outbox.count(), []) ?? 0;

  useEffect(() => {
    getDesiredRetention().then(setRetention);
    loadLastSyncAt();
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

  return (
    <div className="stack">
      <section>
        <h3>Konto &amp; Sync</h3>
        {auth ? <Account email={auth.email} outbox={outboxCount} /> : <AuthForm />}
      </section>

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
          Ausstehende, noch nicht gesyncte Änderungen: {outboxCount}
        </p>
      </section>
    </div>
  );
}

function Account({ email, outbox }: { email: string; outbox: number }) {
  const syncState = useSync();
  return (
    <div className="stack">
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Angemeldet als <strong style={{ color: 'var(--text)' }}>{email}</strong>
      </p>
      <div className="row">
        <button className="primary" disabled={syncState.syncing} onClick={() => void sync()}>
          {syncState.syncing ? 'Synchronisiere…' : 'Jetzt synchronisieren'}
        </button>
        <button onClick={() => void logout()}>Abmelden</button>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Letzter Sync: {fmtTime(syncState.lastSyncAt)} · offen: {outbox}
      </p>
      {syncState.error && (
        <p style={{ fontSize: '0.8rem', color: 'var(--again)' }}>{syncState.error}</p>
      )}
    </div>
  );
}

function AuthForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'login' | 'register') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'register') await register(email.trim(), password);
      else await login(email.trim(), password);
      void sync();
    } catch (e) {
      setError((e as Error).message || 'Fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  const valid = email.includes('@') && password.length >= 8;

  return (
    <div className="stack">
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Anmelden für geräteübergreifenden Sync. Lokale Karten bleiben erhalten und werden hochgeladen.
      </p>
      <div>
        <label>E-Mail</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label>Passwort (min. 8 Zeichen)</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="primary" disabled={!valid || busy} onClick={() => run('login')}>
          {busy ? '…' : 'Anmelden'}
        </button>
        <button disabled={!valid || busy} onClick={() => run('register')}>
          Registrieren
        </button>
      </div>
      {error && <p style={{ fontSize: '0.8rem', color: 'var(--again)' }}>{error}</p>}
    </div>
  );
}
