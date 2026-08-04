import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import {
  exportBackupArchive,
  getDesiredRetention,
  importBackupFile,
  setDesiredRetention,
} from '../db/api';
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
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const auth = useLiveQuery(() => db.meta.get('auth'), [])?.value as Auth | undefined;
  // Nur tatsächlich sendbare Einträge zählen: dauerhaft abgelehnte (syncError) würden die
  // Anzeige "offen: N" sonst nie wieder auf 0 fallen lassen.
  const outboxCount = useLiveQuery(
    () => db.outbox.filter((item) => !item.syncError).count(),
    [],
  ) ?? 0;
  const pendingMediaCount = useLiveQuery(() => db.media.where('synced').equals(0).count(), []) ?? 0;

  useEffect(() => {
    getDesiredRetention().then(setRetention);
    loadLastSyncAt();
  }, []);

  async function onRetention(v: number) {
    setRetention(v);
    await setDesiredRetention(v);
  }

  async function onExport() {
    setBackupBusy(true);
    setImportMsg(null);
    try {
      const blob = await exportBackupArchive();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flashcards-backup-${new Date().toISOString().slice(0, 10)}.flashcards.zip`;
      a.click();
      // Nicht sofort revoken: Safari bricht große Downloads ab, wenn die Object-URL vor
      // dem eigentlichen Download-Start freigegeben wird. Eine Minute reicht sicher.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setImportMsg(`Export fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // gleiche Datei erneut wählbar machen
    if (!file) return;
    if (!window.confirm('Backup einspielen? Vorhandene Karten mit gleicher ID werden überschrieben.')) return;
    setBackupBusy(true);
    setImportMsg(null);
    try {
      const r = await importBackupFile(file);
      setImportMsg(`Importiert: ${r.decks} Decks, ${r.notes} Notizen, ${r.cards} Karten, ${r.media} Bilder.`);
    } catch (err) {
      setImportMsg(`Import fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setBackupBusy(false);
    }
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
        {auth ? (
          <Account
            email={auth.email}
            outbox={outboxCount}
            pendingMedia={pendingMediaCount}
            localDataBusy={backupBusy}
          />
        ) : <AuthForm />}
      </div>

      <div className="section">
        <h2 className="section-head">Daten</h2>
        <div className="group" style={{ padding: 'var(--s4)' }}>
          <div className="stack">
            <button className="block" disabled={backupBusy} onClick={() => void onExport()}>
              {backupBusy ? 'Backup wird verarbeitet…' : 'Vollständiges Backup exportieren'}
            </button>
            <button className="block" disabled={backupBusy} onClick={() => importInputRef.current?.click()}>
              Backup einspielen
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,application/zip,.json,.zip,.flashcards"
              style={{ display: 'none' }}
              onChange={onImportFile}
            />
            <Link to="/app/import" className="btn block">Importieren (CSV/.apkg)</Link>
          </div>
          {importMsg && (
            <p className="info" style={{ marginTop: 'var(--s3)', marginBottom: 0 }}>{importMsg}</p>
          )}
          <p className="info" style={{ marginTop: 'var(--s3)', marginBottom: 0 }}>
            Ausstehende, noch nicht gesyncte Änderungen: {outboxCount}
          </p>
        </div>
      </div>
    </div>
  );
}

function Account({
  email,
  outbox,
  pendingMedia,
  localDataBusy,
}: {
  email: string;
  outbox: number;
  pendingMedia: number;
  localDataBusy: boolean;
}) {
  const syncState = useSync();
  async function onLogout() {
    const pending = [
      outbox > 0 ? `${outbox} noch nicht synchronisierte Änderung(en)` : '',
      pendingMedia > 0 ? `${pendingMedia} noch nicht hochgeladene(s) Bild(er)` : '',
    ].filter(Boolean).join(' und ');
    const msg = pending
      ? `Abmelden löscht lokale Daten inklusive ${pending}. Trotzdem abmelden?`
      : 'Abmelden löscht die lokalen App-Daten auf diesem Gerät. Synchronisierte Daten werden beim erneuten Login wieder geladen. Trotzdem abmelden?';
    if (!window.confirm(msg)) return;
    await logout();
  }
  return (
    <div className="group" style={{ padding: 'var(--s4)' }}>
      <div className="stack">
        <p className="info" style={{ margin: 0 }}>
          Angemeldet als <strong style={{ color: 'var(--label)' }}>{email}</strong>
        </p>
        <div className="row">
          <button className="primary" disabled={syncState.syncing || localDataBusy} onClick={() => void sync()}>
            {syncState.syncing ? 'Synchronisiere…' : 'Jetzt synchronisieren'}
          </button>
          <button disabled={localDataBusy} onClick={() => void onLogout()}>Abmelden</button>
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
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'login' | 'register') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'register') await register(email.trim(), password, inviteCode.trim());
      else await login(email.trim(), password);
      void sync();
    } catch (e) {
      setError((e as Error).message || 'Fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  const valid = email.includes('@') && password.length >= 8;
  const validRegistration = valid && inviteCode.trim().length >= 16;

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
      <div className="field">
        <label className="field-label" htmlFor="auth-invite">
          Einladungscode (nur zur Registrierung)
        </label>
        <input
          id="auth-invite"
          type="text"
          autoComplete="one-time-code"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="primary" disabled={!valid || busy} onClick={() => run('login')}>
          {busy ? '…' : 'Anmelden'}
        </button>
        <button disabled={!validRegistration || busy} onClick={() => run('register')}>
          Registrieren
        </button>
      </div>
      {error && <p className="feedback err" style={{ marginTop: 'var(--s3)' }}>{error}</p>}
    </div>
  );
}
