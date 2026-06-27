# Flashcards

Anki-ähnliche, offline-fähige Spaced-Repetition-PWA mit **FSRS**-Scheduler.
Frontend: React + Vite + PWA. Backend: ein einziger Cloudflare Worker mit Static Assets,
D1 (SQLite) und R2 (Medien). Vollständiger Plan: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Funktioniert bereits (v0.1)

- Decks anlegen, Karten hinzufügen (Einfach / Einfach+Umkehrung / Lückentext-Cloze)
- **FSRS-Review-Loop** mit Intervallvorschau und Tastatur (Leertaste = aufdecken/Gut, 1–4 = Bewertung)
- Lokale Persistenz in IndexedDB (Dexie), offline nutzbar, JSON-Backup-Export
- Karten-Browser mit Suche & Löschen, Ziel-Retention einstellbar
- Worker-API: `/api/health`, Auth (JWT), Delta-Sync (`/api/sync/pull|push`), Medien (R2)

> Cloud-Sync-Endpunkte sind serverseitig lauffähig; die clientseitige Sync-Schleife
> (Login-UI + Outbox-Versand) ist der nächste Meilenstein (M2).

## Lokal entwickeln

```bash
npm install
npm run dev          # Vite-Frontend auf http://localhost:5173 (rein lokal, kein Worker nötig)
```

Mit Worker/Sync lokal:

```bash
npm run db:schema:local   # D1-Schema in die lokale DB
npm run build
npm run preview           # wrangler dev: Frontend + /api/* zusammen auf http://localhost:8787
```

## Cloudflare-Setup (einmalig, Free-Tier)

```bash
npx wrangler login

# D1 anlegen und die ausgegebene database_id in wrangler.jsonc eintragen:
npx wrangler d1 create flashcards-db

# R2-Bucket anlegen:
npx wrangler r2 bucket create flashcards-media

# JWT-Secret setzen:
npx wrangler secret put JWT_SECRET

# Schema in die Remote-DB:
npm run db:schema:remote

# Deploy:
npm run deploy
```

## Automatisches Deployment (GitHub)

**Option A – Cloudflare-Git-Integration (empfohlen):** im Cloudflare-Dashboard
*Workers & Pages → Create → Connect to Git* das Repo `agentnebel/flashcards` verbinden.
Build-Command `npm run build`, Deploy übernimmt Cloudflare bei jedem Push auf `main`.

**Option B – GitHub Actions:** `.github/workflows/deploy.yml` ist vorbereitet. Repo-Secrets
`CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` setzen; Deploy läuft bei Push auf `main`.

> Beide Optionen brauchen die ausgefüllte `database_id` in `wrangler.jsonc` und das gesetzte
> `JWT_SECRET`.

## Kosten

Im kleinen Rahmen 0 €: Worker Free (100k Req/Tag), D1 Free, R2 ohne Egress-Gebühren.

## Lizenz / Hinweise

Eigenständige Re-Implementierung — **kein** offizieller Anki-Code, daher kein AGPL-Bezug.
„Anki" ist eine Marke von Ankitects Pty Ltd; dieses Projekt ist Anki-*ähnlich*, nicht offiziell
sync-kompatibel.
