import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Landing from './screens/Landing';
import './index.css';
import { ensureSeed } from './db/seed';

// Die App (Dexie/Sync/Screens) wird nur noch für /app/* geladen – Landing bleibt eigenständig
// im Hauptbundle, damit anonyme Erstbesucher auf "/" kein App-JS mitladen müssen.
const App = lazy(() => import('./App'));
// Rechtstexte sind Named Exports (eine Datei für beide Seiten) und werden selten besucht –
// daher lazy, mit .then(...) auf das jeweilige Named Export gemappt.
const Impressum = lazy(() => import('./screens/Legal').then((m) => ({ default: m.Impressum })));
const Datenschutz = lazy(() => import('./screens/Legal').then((m) => ({ default: m.Datenschutz })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/impressum"
          element={
            <Suspense fallback={null}>
              <Impressum />
            </Suspense>
          }
        />
        <Route
          path="/datenschutz"
          element={
            <Suspense fallback={null}>
              <Datenschutz />
            </Suspense>
          }
        />
        <Route
          path="/app/*"
          element={
            <Suspense fallback={null}>
              <App />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

// Sofort rendern – nicht auf ensureSeed (IndexedDB öffnen + Counts) warten, das hing
// bisher auf dem kritischen Pfad vor dem ersten Paint. Die Screens lesen ihre Daten per
// Dexie-liveQuery; sobald der Seed (nur beim allerersten Start) Daten anlegt, aktualisiert
// sich die Ansicht reaktiv. Für bestehende Nutzer ist ensureSeed ohnehin ein No-Op.
// Nur auf /app/* nötig – auf der Marketing-Landingpage ("/") soll kein IndexedDB-Zugriff
// anfallen, den anonyme Besucher nie brauchen.
if (window.location.pathname.startsWith('/app')) void ensureSeed();
