import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Landing from './screens/Landing';
import './index.css';

// Die App (Dexie/Sync/Screens) wird nur noch für /app/* geladen – Landing bleibt eigenständig
// im Hauptbundle, damit anonyme Erstbesucher auf "/" kein App-JS mitladen müssen.
const App = lazy(() => import('./App'));
// Rechtstexte sind Named Exports (eine Datei für beide Seiten) und werden selten besucht –
// daher lazy, mit .then(...) auf das jeweilige Named Export gemappt.
const Impressum = lazy(() => import('./screens/Legal').then((m) => ({ default: m.Impressum })));
const Datenschutz = lazy(() => import('./screens/Legal').then((m) => ({ default: m.Datenschutz })));

// Data Router statt BrowserRouter: Nur damit kann AddCard interne Navigationen und
// Browser-Zurück zuverlässig blockieren, solange Formulardaten ungespeichert sind.
const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  {
    path: '/impressum',
    element: (
      <Suspense fallback={null}>
        <Impressum />
      </Suspense>
    ),
  },
  {
    path: '/datenschutz',
    element: (
      <Suspense fallback={null}>
        <Datenschutz />
      </Suspense>
    ),
  },
  {
    path: '/app/*',
    element: (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    ),
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
