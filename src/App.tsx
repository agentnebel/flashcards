import { useEffect, useSyncExternalStore } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import DeckList from './screens/DeckList';
import Review from './screens/Review';
import AddCard from './screens/AddCard';
import Browse from './screens/Browse';
import Settings from './screens/Settings';
import { getAuth, getSyncState, loadLastSyncAt, subscribeSync, sync } from './sync/engine';

export default function App() {
  const syncState = useSyncExternalStore(subscribeSync, getSyncState);

  // Auto-Sync: bei Start, beim Online-Gehen, beim Sichtbarwerden und periodisch.
  useEffect(() => {
    const trigger = async () => {
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
    <div className="app">
      <header className="topbar">
        <h1>Flashcards</h1>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          {syncState.syncing ? '↻ Sync…' : 'FSRS'}
        </span>
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<DeckList />} />
          <Route path="/deck/:deckId/study" element={<Review />} />
          <Route path="/add" element={<AddCard />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <nav className="navbar">
        <NavLink to="/" end>Decks</NavLink>
        <NavLink to="/add">Hinzufügen</NavLink>
        <NavLink to="/browse">Karten</NavLink>
        <NavLink to="/settings">Einstellungen</NavLink>
      </nav>
    </div>
  );
}
