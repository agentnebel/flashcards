# Flashcards

Eine Lernkarten-App fürs Handy und den Browser. Karten anlegen, lernen, von überall synchronisieren — kein Account bei einem Drittanbieter nötig, keine Werbung, kein Abo.

---

## DEMO

[Preview](https://flashcards.belz.cloud)


## Was die App kann

**Lernen**
- Karten werden nach einem intelligenten Intervall-Algorithmus (FSRS) wiederholt — wer eine Karte gut kennt, sieht sie seltener. Das spart Zeit.
- Karte antippen oder Leertaste drücken → Antwort aufdecken. Dann bewerten: Nochmal / Schwer / Gut / Einfach.
- Swipe nach rechts = Gut, nach links = Nochmal (auf dem Handy).
- Auf dem Desktop funktionieren die Tasten 1–4 für die Bewertung.
- Oben rechts läuft ein kleiner Fortschrittsring mit, wie viele Karten in der Sitzung schon erledigt sind.

**Übersicht**
- Die Decks-Seite zeigt direkt: wie viele Karten heute fällig sind und wie viele Tage am Stück schon gelernt wurde (Streak).
- Jedes Deck zeigt farbige Zähler — grün für fällige Reviews, blau für neue Karten (gedeckelt auf das Tageslimit des Decks, abzüglich heute bereits gelernter neuer Karten).

**Karten erstellen**
- Drei Kartentypen: einfach Vorder-/Rückseite, Vorder-/Rückseite mit automatischer Umkehrung und Lückentext.
- Bilder lassen sich per Einfügen (⌘V / Strg+V), Datei-Button oder Drag & Drop hinzufügen. Die App komprimiert sie automatisch.

**Karten verwalten**
- In der Karten-Liste lassen sich Karten bearbeiten und löschen.
- Decks umbenennen oder löschen: oben rechts „Bearbeiten" tippen, dann erscheint pro Deck ein roter Minus-Button.

**Import**
- CSV und TSV-Dateien lassen sich direkt importieren — mit Spalten-Vorschau und frei wählbarem Feld-Mapping.
- Ältere `.apkg`-Dateien (Karteikarten-Export im verbreiteten Format) werden ebenfalls eingelesen.

**Sync**
- In den Einstellungen einmal registrieren (Einladungscode erforderlich, siehe unten) und anmelden.
- Danach werden Karten und Reviews automatisch über alle Geräte synchronisiert — beim Start, beim Öffnen, beim Online-Gehen und alle 60 Sekunden.
- Bilder werden über Cloudflare R2 synchronisiert, wenn R2 aktiviert ist.
- Tägliche Sync-Budgets schützen das gemeinsame Cloudflare-Kontingent: Sehr große Importe werden dadurch über mehrere Tage verteilt hochgeladen (die App setzt automatisch fort, nichts geht verloren).

**Datensicherung**
- Über Einstellungen → Backup lässt sich alles als kompaktes `.flashcards.zip` exportieren, Bilder inklusive.
- Ältere JSON-Backups bleiben importierbar.

---

## Technischer Stack

| Bereich | Technologie |
|---|---|
| Frontend | React, Vite, PWA |
| Lernalgorithmus | FSRS (`ts-fsrs`) |
| Lokale Datenbank | Dexie (IndexedDB) |
| Backend | Cloudflare Worker |
| Datenbank (Server) | Cloudflare D1 (SQLite) |
| Medien-Speicher | Cloudflare R2 |
| Deployment | GitHub Actions → Cloudflare |

Die App läuft komplett offline — der Worker wird nur für den Sync gebraucht.

---

## Installation

Vorausgesetzt werden [Node.js](https://nodejs.org) 22 oder neuer (bringt `npm` schon mit) und `git`.

**1. Repo klonen**

```bash
git clone https://github.com/agentnebel/flashcards.git
cd flashcards
```

**2. Abhängigkeiten installieren**

```bash
npm install
```

**3. App starten**

```bash
npm run dev
```

**4. Im Browser öffnen**

[http://localhost:5173](http://localhost:5173) — Karten anlegen, direkt lernen. Ohne Account läuft alles lokal im Browser (IndexedDB), es wird nichts synchronisiert.

Für den Produktiv-Build (das, was auch deployt wird):

```bash
npm run build   # baut nach ./dist
```

### Sync lokal testen (optional, Worker + D1)

Wer auch den Cloudflare-Teil (Login, Sync über mehrere Geräte) lokal ausprobieren will:

```bash
echo 'JWT_SECRET=dev-secret-with-at-least-32-characters' > .dev.vars
npm run db:schema:local
npm run db:invite:local
npm run build
npx wrangler dev --port 8787
# in einem zweiten Terminal:
npm run dev
```

---

## Cloudflare einrichten (einmalig)

```bash
npx wrangler login

# Datenbank anlegen — database_id in wrangler.jsonc eintragen:
npx wrangler d1 create flashcards-db

# Medien-Bucket:
npx wrangler r2 bucket create flashcards-media

# JWT-Secret setzen (mindestens 32 Zeichen, sonst antwortet die Auth mit 500):
npx wrangler secret put JWT_SECRET

# Schema in die Remote-DB:
npm run db:schema:remote

# Ein einmal verwendbarer Registrierungscode (standardmäßig 7 Tage gültig):
npm run db:invite:remote

# Deployen:
npm run deploy
```

Bei einer bestehenden Installation ist ein kurzes, bewusstes Wartungsfenster nötig. Nicht
0003 unter dem alten öffentlichen Worker ausführen: Dessen Schreibpfade kennen die neuen
Tagesbudgets noch nicht. Der sichere Ablauf ist:

```bash
# 1. Read-only prüfen. Bei zurückgegebenen Limit-Verletzungen NICHT fortfahren.
npm run db:preflight:sync-quotas:remote

# 2. Neue Worker-Version vorab im API-Wartungsmodus deployen.
npm run deploy:maintenance

# 3. Erst jetzt beide Schema-Migrationen ausführen und anschließend den normalen Worker deployen.
npm run db:migrate:sync-quotas:remote
npm run db:migrate:registration-invites:remote
npm run deploy
```

Während Schritt 2 antwortet `/api/health` weiterhin, alle anderen API-Routen liefern 503.
Vor Schritt 3 diesen Zustand prüfen. Scheitert die Migration, den Wartungsmodus aktiv lassen
und nicht den normalen Worker deployen.

War die Sync-/Quota-Migration 0003 bereits früher erfolgreich abgeschlossen, wird im
Wartungsfenster nur noch `db:migrate:registration-invites:remote` ausgeführt. 0003 wegen
des enthaltenen `ALTER TABLE` nicht erneut starten.

Erst wenn die produktive D1-Datenbank Schema-Version 4 besitzt und der normale Worker
verifiziert ist (bei Neuinstallationen durch `db:schema:remote`, bei bestehenden
Installationen durch die Migration oben),
in GitHub unter **Settings → Secrets and variables → Actions → Variables** die Variable
`FLASHCARDS_SCHEMA_VERSION` auf `4` setzen. Der Deploy-Workflow bleibt bis dahin absichtlich
gesperrt, damit Worker und Datenbankschema nicht auseinanderlaufen. Wurde der ursprüngliche
Push deshalb übersprungen, den Workflow anschließend einmal manuell über `workflow_dispatch`
starten.

Neue Konten brauchen einen einmal verwendbaren Einladungscode. Der Klartext wird nur beim
Erzeugen ausgegeben; D1 speichert ausschließlich seinen SHA-256-Hash. Weitere Codes lassen
sich jederzeit erzeugen (optional mit 1–90 Tagen Gültigkeit):

```bash
npm run db:invite:remote
node scripts/d1-create-invite.mjs --remote --days=30
```

Nach dem erfolgreichen Worker-Deploy und einem geprüften Sync den einmaligen finalen
Backfill ausführen:

```bash
npm run db:finalize:sync-migration:remote
```

Diese Finalisierung bewusst nicht vor dem Deploy ausführen: Der vorherige Worker kann noch
historische Feed-Zeilen benötigen. Die Tabelle `change_log` selbst bleibt dauerhaft als
globaler AUTOINCREMENT-Allocator bestehen; ein Trigger entfernt jede neue Zeile sofort.

Historische Feed-Zeilen anschließend optional in kleinen 1.000er-Batches bereinigen:

```bash
npm run db:cleanup:legacy-log:remote
```

Dieser separate Befehl meldet, ob weitere Zeilen vorhanden sind, und kann wiederholt werden,
ohne bei jedem Batch den vollständigen Restbestand zu zählen oder den Backfill aus 0004 erneut
auszuführen.

---

## Automatisches Deployment

Der Workflow in `.github/workflows/deploy.yml` prüft jeden Push auf `main` und deployt
automatisch, sobald Cloudflare-Zugangsdaten und Schema-Version 4 bestätigt sind.

Dafür im GitHub-Repo setzen:
- `CLOUDFLARE_API_TOKEN` (Workers-Token aus dem Cloudflare-Dashboard)
- `CLOUDFLARE_ACCOUNT_ID`
- Repository-Variable `FLASHCARDS_SCHEMA_VERSION=4`

---

## Kosten

Die Anwendung begrenzt Sync-, D1- und R2-Nutzung, damit sie nicht unkontrolliert Ressourcen
verbraucht. Eine Garantie von 0 € gibt es trotzdem nicht: Cloudflare-Tarife und accountweite
Nutzung können sich ändern bzw. Limits überschreiten. Vor dem Produktivbetrieb Billing-Limits
und Usage Alerts im Cloudflare-Dashboard konfigurieren.

Die Registrierung ist fail-closed und setzt einen einmal verwendbaren, zeitlich begrenzten
Einladungscode voraus. Zusätzlich gelten für kleine Installationen weiterhin 100 Konten,
global fünf neue Konten pro UTC-Tag und ein neues Konto pro IP/UTC-Tag. So können anonyme
Fake-Accounts den gemeinsamen Sync-Speicher nicht allein durch Self-Signup belegen. Für eine
öffentliche, größere Instanz empfiehlt sich weiterhin ein externer Identity Provider.

Die Passwortableitung ist absichtlich rechenintensiv. Der Workers-Free-Tarif kann mit seinem
engen CPU-Limit für Login/Registrierung zu klein sein; diese beiden Routen deshalb unter realer
Last in den Worker-Logs prüfen oder einen Paid-Plan bzw. externen Identity Provider verwenden.

---

## Lizenz

MIT
