import { useEffect, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import DeckList from './screens/DeckList';
import Review from './screens/Review';
import AddCard from './screens/AddCard';
import Browse from './screens/Browse';
import Settings from './screens/Settings';
import Import from './screens/Import';
import { db } from './db/db';
import { useOnlineStatus } from './lib/useOnlineStatus';
import { getAuth, getSyncState, loadLastSyncAt, subscribeSync, sync } from './sync/engine';

function IconOffline() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5a7 7 0 0 1 11-1.5M8.5 16a4 4 0 0 1 5 -.6" />
      <path d="M12 20h.01" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function IconDecks() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2.5" />
      <path d="M7 20h10" />
    </svg>
  );
}
function IconAdd() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
function IconCards() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="2.5" />
      <path d="M8 4.5l9 1.6a2 2 0 0 1 1.6 2.3L17 18" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13a7.8 7.8 0 0 0 0-2l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-1.7-1l-.3-2.1H9.7l-.3 2.1a7.6 7.6 0 0 0-1.7 1l-2-.8L3.9 9.7 5.6 11a7.8 7.8 0 0 0 0 2l-1.7 1.3 1.8 3.1 2-.8c.5.4 1.1.7 1.7 1l.3 2.1h4.6l.3-2.1c.6-.3 1.2-.6 1.7-1l2 .8 1.8-3.1z" />
    </svg>
  );
}

export default function App() {
  const syncState = useSyncExternalStore(subscribeSync, getSyncState);
  const online = useOnlineStatus();
  // Anzahl noch nicht synchronisierter lokaler Änderungen (Outbox). Live, damit das
  // Offline-Badge mitzählt, während offline weiter gelernt/bearbeitet wird.
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const location = useLocation();

  // Während des Lernens (Review) auf Mobile die Tableiste ausblenden (Fokus).
  const isReview = /^\/deck\/[^/]+\/study$/.test(location.pathname);

  // Auto-Sync: bei Start, beim Online-Gehen, beim Sichtbarwerden und periodisch.
  useEffect(() => {
    const trigger = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // offline: kein Versuch
      if (await getAuth()) void sync();
    };
    loadLastSyncAt();
    void trigger();
    const onOnline = () => void trigger();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void trigger();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void trigger(), 60_000);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className={`app${isReview ? ' focus-mode' : ''}`}>
      <header className="topbar">
        <span className="sync-ind" aria-live="polite">
          {!online ? (
            <span
              className="offline-badge"
              title={
                pending && pending > 0
                  ? `Offline – ${pending} Änderung${pending === 1 ? '' : 'en'} werden bei Verbindung synchronisiert`
                  : 'Offline – alle Daten sind lokal verfügbar'
              }
            >
              <IconOffline />
              <span>Offline{pending && pending > 0 ? ` · ${pending}` : ''}</span>
            </span>
          ) : syncState.syncing ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="visually-hidden">Synchronisiere</span>
            </>
          ) : null}
        </span>
      </header>

      <nav className="navbar">
        <span className="sidebar-head">Flashcards</span>
        <NavLink to="/" end>
          <IconDecks />
          <span>Decks</span>
        </NavLink>
        <NavLink to="/add">
          <IconAdd />
          <span>Hinzufügen</span>
        </NavLink>
        <NavLink to="/browse">
          <IconCards />
          <span>Karten</span>
        </NavLink>
        <NavLink to="/settings">
          <IconSettings />
          <span>Einstellungen</span>
        </NavLink>
      </nav>

      <main className="content">
        <Routes>
          <Route path="/" element={<DeckList />} />
          <Route path="/deck/:deckId/study" element={<Review />} />
          <Route path="/add" element={<AddCard />} />
          <Route path="/edit/:noteId" element={<AddCard />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<Import />} />
        </Routes>
      </main>
    </div>
  );
}
