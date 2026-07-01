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
- Jedes Deck zeigt farbige Zähler — grün für fällige Reviews, blau für neue Karten.

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
- In den Einstellungen einmal registrieren und anmelden.
- Danach werden Karten und Reviews automatisch über alle Geräte synchronisiert — beim Start, beim Öffnen, beim Online-Gehen und alle 60 Sekunden.
- Bilder werden über Cloudflare R2 synchronisiert, wenn R2 aktiviert ist.

**Datensicherung**
- Über Einstellungen → Backup lässt sich alles als JSON-Datei exportieren, Bilder inklusive.

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

Vorausgesetzt werden [Node.js](https://nodejs.org) 20 oder neuer (bringt `npm` schon mit) und `git`.

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
echo 'JWT_SECRET=dev-secret' > .dev.vars
npm run db:schema:local
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

# JWT-Secret setzen:
npx wrangler secret put JWT_SECRET

# Schema in die Remote-DB:
npm run db:schema:remote

# Deployen:
npm run deploy
```

---

## Automatisches Deployment

Der Workflow in `.github/workflows/deploy.yml` deployt automatisch bei jedem Push auf `main`.

Dafür zwei Secrets im GitHub-Repo setzen:
- `CLOUDFLARE_API_TOKEN` (Workers-Token aus dem Cloudflare-Dashboard)
- `CLOUDFLARE_ACCOUNT_ID`

---

## Kosten

Im normalen Rahmen entstehen keine Kosten: Worker Free (100k Anfragen/Tag), D1 Free, R2 ohne Egress-Gebühren.

---

## Lizenz

MIT
