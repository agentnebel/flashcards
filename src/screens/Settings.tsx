import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
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
    <div>
      <h1 className="screen-title">Einstellungen</h1>

      <div className="section">
        <h2 className="section-head">FSRS</h2>
        <div className="group" style={{ padding: 'var(--s4)' }}>
          <label className="field-label" htmlFor="retention">
            Ziel-Retention: {Math.round(retention * 100)} %
          </label>
          <input
            id="retention"
            type="range"
            min={0.8}
            max={0.97}
            step={0.01}
            value={retention}
            onChange={(e) => onRetention(parseFloat(e.target.value))}
          />
          <p className="info" style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
            Höher = häufigere Wiederholungen, bessere Behaltensquote.
          </p>
        </div>
      </div>

      <div className="section">
        <h2 className="section-head">Konto &amp; Sync</h2>
        {auth ? <Account email={auth.email} outbox={outboxCount} /> : <AuthForm />}
      </div>

      <div className="section">
        <h2 className="section-head">Daten</h2>
        <div className="group" style={{ padding: 'var(--s4)' }}>
          <div className="stack">
            <button className="block" onClick={onExport}>JSON-Backup exportieren</button>
            <Link to="/import" className="btn block">Importieren (CSV/.apkg)</Link>
          </div>
          <p className="info" style={{ marginTop: 'var(--s3)', marginBottom: 0 }}>
            Ausstehende, noch nicht gesyncte Änderungen: {outboxCount}
          </p>
        </div>
      </div>
    </div>
  );
}

function Account({ email, outbox }: { email: string; outbox: number }) {
  const syncState = useSync();
  return (
    <div className="group" style={{ padding: 'var(--s4)' }}>
      <div className="stack">
        <p className="info" style={{ margin: 0 }}>
          Angemeldet als <strong style={{ color: 'var(--label)' }}>{email}</strong>
        </p>
        <div className="row">
          <button className="primary" disabled={syncState.syncing} onClick={() => void sync()}>
            {syncState.syncing ? 'Synchronisiere…' : 'Jetzt synchronisieren'}
          </button>
          <button onClick={() => void logout()}>Abmelden</button>
        </div>
        <p className="info" style={{ margin: 0 }}>
          Letzter Sync: {fmtTime(syncState.lastSyncAt)} · offen: {outbox}
        </p>
        {syncState.error && <p className="feedback err">{syncState.error}</p>}
      </div>
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
    <div className="group" style={{ padding: 'var(--s4)' }}>
      <p className="info" style={{ marginTop: 0 }}>
        Anmelden für geräteübergreifenden Sync. Lokale Karten bleiben erhalten und werden hochgeladen.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="auth-email">E-Mail</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="auth-pw">Passwort (min. 8 Zeichen)</label>
        <input
          id="auth-pw"
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
      {error && <p className="feedback err" style={{ marginTop: 'var(--s3)' }}>{error}</p>}
    </div>
  );
}
