import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { ensureSeed } from './db/seed';

// Sofort rendern – nicht auf ensureSeed (IndexedDB öffnen + Counts) warten, das hing
// bisher auf dem kritischen Pfad vor dem ersten Paint. Die Screens lesen ihre Daten per
// Dexie-liveQuery; sobald der Seed (nur beim allerersten Start) Daten anlegt, aktualisiert
// sich die Ansicht reaktiv. Für bestehende Nutzer ist ensureSeed ohnehin ein No-Op.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

void ensureSeed();
