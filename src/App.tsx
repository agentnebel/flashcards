import { NavLink, Route, Routes } from 'react-router-dom';
import DeckList from './screens/DeckList';
import Review from './screens/Review';
import AddCard from './screens/AddCard';
import Browse from './screens/Browse';
import Settings from './screens/Settings';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Flashcards</h1>
        <span className="muted" style={{ fontSize: '0.8rem' }}>FSRS</span>
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
