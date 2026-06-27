# Flashcards — Implementierungsplan

> Anki-ähnliche, offline-fähige Spaced-Repetition-PWA auf Cloudflare.
> Basiert auf den beiden Research-Berichten (Research1 = AnkiWeb-Architektur/FSRS, Research2 = MVP-Strategie & Stack-Vergleich).

## 1. Kontext & Ziel

Ziel ist eine eigene, **Anki-nahe** (nicht offiziell sync-kompatible) Lern-App als **PWA**, die
möglichst **kostenlos** auf **Cloudflare** läuft und über **GitHub** (`agentnebel/flashcards`)
deployt wird. Bewusste Strategie laut Research2: **„datei-/modellkompatibel, aber nicht
Server-Protokoll-kompatibel"** — wir bauen ein eigenes, stabiles JSON-API statt das interne,
nicht-öffentliche Anki-Sync-Protokoll nachzuziehen. Das eliminiert Lizenz- (AGPL), Trademark-
und Protokoll-Drift-Risiken.

**Festgelegte Entscheidungen (vom Nutzer bestätigt):**

| Thema | Entscheidung | Begründung |
|---|---|---|
| Scope v1 | **Cloud-Sync ab v1** (Multi-Device) | Login + Delta-Sync + Medien von Anfang an |
| Scheduler | **FSRS** (`ts-fsrs`, Desired Retention, Default-Gewichte) | Kein „Ease Hell", modern, ~20–30 % weniger Reviews (Research1) |
| Import | **.apkg + CSV** | Bestehende Anki-Decks + simple Listen importierbar |
| Frontend | **React + Vite + PWA** | Passt zur bestehenden `regenschirm-app`-Toolchain |

## 2. Architektur-Überblick

Ein **einziges Cloudflare-Worker-Deployment** mit **Static Assets** (wie `dailydose`):
der Worker serviert das gebaute React-Bundle und behandelt `/api/*` selbst.

```
┌─────────────────────── Browser (PWA) ───────────────────────┐
│  React + Vite          Service Worker (vite-plugin-pwa)      │
│  Dexie (IndexedDB)  ◄── lokale Single-Source-of-Truth        │
│  ts-fsrs Scheduler      Outbox (ausgehende Mutationen)       │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTPS  (nur Delta-Sync + Medien)
┌───────────────▼─────────── Cloudflare ──────────────────────┐
│  Worker (`/api/*` via run_worker_first)                     │
│    /api/auth/*   JWT-Login/Register                         │
│    /api/sync/pull|push   Delta-Sync (USN-Cursor)            │
│    /api/media/*  signierte R2-URLs                          │
│  D1 (SQLite)   normalisiert: users, decks, notes, cards,    │
│                revlog, media, tombstones, change_log        │
│  R2            content-addressed Medien (sha256)            │
└─────────────────────────────────────────────────────────────┘
```

**Leitprinzip:** Der Client ist **offline-first**. Alle Lese-/Schreiboperationen laufen gegen
Dexie; Sync ist ein Hintergrundprozess (Outbox → push, Cursor → pull). Der FSRS-Scheduler läuft
**clientseitig deterministisch**, damit offline gelernt werden kann.

## 3. Tech-Stack

| Schicht | Wahl | Free-Tier |
|---|---|---|
| Hosting/Compute | Cloudflare Worker + Static Assets | 100k Req/Tag |
| DB | Cloudflare **D1** (SQLite) | Free-Plan |
| Medien | Cloudflare **R2** | kein Egress, 10 GB Free |
| Frontend | React 19 + Vite 6 + TypeScript | — |
| Offline-Store | **Dexie** (IndexedDB) | — |
| Scheduler | **ts-fsrs** | — |
| PWA | `vite-plugin-pwa` (Workbox) | — |
| Router (Worker) | `itty-router` | — |
| Auth | JWT (HS256) + `bcryptjs`/WebCrypto | — |
| CI/CD | GitHub Actions → `wrangler deploy` | — |

## 4. Datenmodell

### 4.1 Client (Dexie / IndexedDB)
Tabellen: `decks`, `notes`, `cards`, `revlog`, `noteTypes`, `outbox`, `meta`.
Strikte **Note/Card-Trennung** (wie Anki): Notes tragen Inhalt, Cards werden aus
Note-Type-Templates generiert (Basic, Basic+reversed, Cloze).

- `cards` hält den **FSRS-State** direkt: `due, stability, difficulty, elapsed_days,
  scheduled_days, reps, lapses, state(0=New,1=Learning,2=Review,3=Relearning), last_review`,
  plus `suspended`, `buriedUntil`, `usn`.
- `outbox`: `{id, op, entity, entityId, payload, createdAt}` — wird bei Reconnect an
  `/api/sync/push` gesendet.
- `meta`: `syncCursor`, `authToken`, `deviceId`, `desiredRetention`, …

### 4.2 Server (D1, normalisiert — Research1-Empfehlung)
Kein denormalisiertes Anki-Schema. Stattdessen:

| Tabelle | Zweck / wichtige Felder |
|---|---|
| `users` | `id, email, password_hash, created_at` |
| `decks` | `id, user_id, name, parent_id` (Adjazenzliste statt `::`-Strings), `config_json`, `usn, deleted` |
| `note_types` | `id, user_id, name, kind, fields_json, templates_json, css` |
| `notes` | `id, user_id, note_type_id, guid, fields_json, tags, sort_field, usn, deleted` |
| `cards` | `id, user_id, note_id, deck_id, template_ord`, FSRS-Felder, `due_at, queue, usn, deleted` |
| `revlog` | append-only Review-Events |
| `media` | `id, user_id, sha256, mime, size, r2_key` (content-addressed) |
| `change_log` | `seq (autoinc), user_id, entity, entity_id, op, changed_at` → Delta-Cursor |
| `tombstones` | logische Löschungen (auch via `deleted`-Flag + change_log abbildbar) |

IDs: **UUID v7** (zeitsortierbar) statt Anki-Millisekunden-IDs → keine Kollisionen bei
parallelem Multi-Device-Anlegen.

## 5. Sync-Design (eigenes Delta-Protokoll)

Append-only **`change_log`** mit monoton steigendem `seq` als Cursor (vereinfachtes USN-Modell).

- **`POST /api/sync/push`** — Batch aus Outbox: `{baseCursor, mutations[], revlog[]}`.
  Server wendet idempotent an, schreibt `change_log`-Einträge, gibt `newCursor` + Konflikte zurück.
- **`POST /api/sync/pull`** — `{cursor}` → alle geänderten Entitäten seit `cursor` + neuer Cursor.
- **Konfliktklassen (Anki-Vorbild):** Reviews & einfache Note-Edits → automatisch mergen
  (last-write-wins pro Feld + Revlog ist append-only). Strukturänderungen (Note-Type-/Template-
  Umbau) → als **hard conflict** markieren, nicht stillschweigend mergen.
- **Medien** getrennt: Client lädt fehlende Hashes via signierte R2-URLs hoch/runter; nie über
  den DB-Sync.

## 6. Scheduler (FSRS via ts-fsrs)

- `generatorParameters({ request_retention: desiredRetention, enable_fuzz: true })`.
- Pro Review: `f.next(card, now, Rating.Again|Hard|Good|Easy)` → neuer Card-State + Log.
- Vier Antwort-Buttons mit **Intervall-Vorschau** (wie Anki V3).
- Zustände New/Learning/Review/Relearning aus `card.state`. Young/Mature (<>21 Tage) für Stats.
- **Phase 2:** FSRS-Parameter-Optimierung aus `revlog` (nicht MVP-kritisch; Default-Gewichte
  liefern bereits gute Ergebnisse).

## 7. Import / Export

- **CSV/TSV** (v1): Mapping-Dialog (Spalte → Feld), Deck-Ziel, Duplikat-Erkennung über `sort_field`-Checksum.
- **.apkg-Import** (v1→früh): ZIP via `fflate` entpacken → `collection.anki2` (SQLite) via
  `sql.js` (WASM) im **Web Worker** lesen → Notes/Cards/Note-Types/Decks/Medien mappen →
  Dexie + Outbox. Anki-Scheduling-Felder werden in FSRS-Initialwerte übersetzt (oder Karten als
  „neu" importiert — konfigurierbar).
- **Export:** JSON-Backup (v1), `.apkg`-Export (Phase 2) für Rückweg in Anki Desktop/Mobile.

## 8. Auth & Security

- Registrierung/Login → JWT (HS256, `JWT_SECRET` als Worker-Secret), Passwort-Hash via bcrypt/WebCrypto.
- Pro Request **strikte Objekt-Autorisierung** (`user_id`-Scoping aller D1-Queries).
- Rate-Limiting auf `/api/auth/*` und Media-Upload. Datensparsamkeit (nur E-Mail + Hash).
- HTTPS-only, Token im Memory/`localStorage` (kein Cookie → kein CSRF-Vektor für die JSON-API).

## 9. Kosten

Bei kleinem Nutzerkreis **0 €**: Worker Free (100k Req/Tag), D1 Free, R2 Free (kein Egress).
GitHub Actions Free-Minutes reichen für Deploys. Keine zweite Cloud nötig.

## 10. Repository & Deployment

- **Quelle:** `github.com/agentnebel/flashcards` (Single-Repo).
- **Build:** `npm run build` → `dist/` (React-Bundle). Worker = `worker/index.ts`.
- **Deploy:** `wrangler deploy` (manuell) **oder** GitHub Actions bei Push auf `main`
  (`.github/workflows/deploy.yml`, nutzt `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` Secrets).
- **Cloudflare-Einmal-Setup** (im Dashboard/CLI, siehe README): D1 + R2 anlegen, Binding-IDs in
  `wrangler.jsonc` eintragen, `JWT_SECRET` setzen, `wrangler d1 execute` für Schema.

## 11. Roadmap / Meilensteine

| M | Inhalt | Status |
|---|---|---|
| **M0** | Scaffold deploybar: React-PWA + Worker + D1-Schema, leerer Sync, CI | **dieser Commit** |
| **M1** | Lokaler Kern komplett: Decks, Note-Types, Add/Edit, **FSRS-Review-Loop**, Browse, Dexie-Persistenz | dieser Commit (Kern) |
| **M2** | Auth (Register/Login) + Delta-Sync (push/pull, Outbox, Cursor, Tombstones) | nächste Iteration |
| **M3** | Medien: R2-Upload/Download, Bild/Audio in Karten | danach |
| **M4** | Import: CSV (zuerst), dann .apkg (sql.js+fflate im Worker-Thread) | danach |
| **M5** | Stats (Young/Mature, Retention-Heatmap), FSRS-Optimierung, .apkg-Export, Filtered Decks | später |

## 12. In diesem Commit enthalten (M0 + M1-Kern)

- Vollständiges Vite-React-TS-Projekt, baubar (`npm run build`) und deploybar.
- Dexie-Datenmodell + Seed (Standard-Deck & Note-Types Basic/Cloze).
- ts-fsrs-Scheduler-Wrapper + funktionierender Review-Flow mit Intervall-Vorschau & Tastatur (1–4/Space).
- Screens: Deck-Liste, Review, Karte hinzufügen, Browser, Einstellungen.
- PWA (Manifest + Service Worker, offline lauffähig).
- Worker-Backend-Scaffold (`itty-router`): `/api/health`, Auth-Stubs, `/api/sync/pull|push`-Gerüst, Media-Stubs.
- D1-Schema-SQL, `wrangler.jsonc`, GitHub-Actions-Deploy, README mit Setup.

> Sync-Logik (M2) ist als API-Vertrag + Outbox-Hooks vorbereitet, aber serverseitig noch ein
> Gerüst — die App ist als lokale PWA bereits voll nutzbar.
