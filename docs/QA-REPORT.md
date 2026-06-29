# QA-Report — Flashcards (Stand 2026-06-29)

QA-Durchlauf als koordiniertes Team: ein QA-Engineer (Lead, Triage/Review/Fixes) plus
fünf spezialisierte Tester, die je eine Domäne read-only auf Bugs & Edge-Cases geprüft
und Findings mit Schweregrad, Fundstelle und Repro gemeldet haben.

| Tester | Domäne |
|---|---|
| A | Spaced-Repetition / Study-Logik (FSRS, Study-Queue, Streak, Review) |
| B | Sync-Engine, Auth & Worker-Backend |
| C | Import (.apkg / CSV) & Kartengenerierung |
| D | Medien & Datenintegrität (Upload, Kompression, Backup) |
| E | UI/UX-Flows, React-State & PWA |

Insgesamt ~30 Findings. Davon **22 behoben**, der Rest bewusst zurückgestellt (Begründung
unten). Verifiziert via App-Build, separatem Worker-Typecheck, UI-Smoke-Test und
Unit-Tests der reinen Funktionen gegen den echten Quellcode (dynamischer Import im Browser).

---

## Behoben

### Kritisch
1. **`logout()` löschte keine lokalen Daten → Cross-Account-Leck & -Kontamination.**
   Auf einem geteilten Gerät blieben Karten/Notizen des Vorkontos sichtbar; schlimmer:
   die nicht gesyncte Outbox wurde beim nächsten Login unter *fremdem* Token hochgeladen.
   → `logout()` leert jetzt alle Tabellen + Outbox + Cursor/lastSync in einer Transaktion.
   Synchronisierte Daten gehen nicht verloren (Login pullt ab Cursor 0 neu). *(engine.ts)*
2. **JSON-Backup war eine Einbahnstraße** (Export ohne Import; Datumsfelder/Medien
   hätten nicht rückkonvertiert werden können). → `importBackup()` implementiert: revived
   alle `Date`-Felder (`due`/`fsrs.due`/`fsrs.last_review`/`revlog.due`), dekodiert Medien
   (base64→Blob), idempotenter `bulkPut`. Button „JSON-Backup einspielen" in den Einstellungen.
   *(api.ts, Settings.tsx)*

### Hoch
3. **JWT-Verify warf bei kaputtem Token → 500 statt 401.** `verifyJwt` komplett in
   try/catch gekapselt. *(auth.ts)*
4. **E-Mail nicht normalisiert → Doppelkonten / Login-Fehlschlag bei Groß/Klein.**
   `trim().toLowerCase()` + `COLLATE NOCASE` (rückwärtskompatibel mit Altkonten). *(auth.ts)*
5. **Server vertraute beliebigem `entity`/`payload`.** Entity-Allowlist, Upsert verlangt
   `payload.id === entityId`, Revlog-Löschungen werden nicht propagiert (append-only). *(sync.ts)*
6. **Medien-Endpoint: kein Schutz gegen SVG/aktive Inhalte.** SVG-Upload abgelehnt,
   ausgelieferter Content-Type auf Rasterbild beschränkt, `X-Content-Type-Options: nosniff`. *(media.ts)*
7. **Object-URLs wurden nie freigegeben → Memory-Leak im Review.** LRU-Cache (max 120)
   mit `revokeObjectURL` bei Verdrängung. *(media.ts)*
8. **`deck.newPerDay` wurde komplett ignoriert** (hartcodiertes Limit 20, zudem pro
   Queue-Rebuild statt pro Tag). → Study-Queue respektiert `newPerDay` und zieht heute
   bereits eingeführte neue Karten ab (echtes Tageslimit). *(api.ts)*
9. **CSV-Parser:** CR-only-Zeilenenden kollabierten die ganze Datei zu einer Zeile; BOM
   verunreinigte das erste Feld; Delimiter-Erkennung zählte auch in Quotes. Alle drei behoben. *(csv.ts)*

### Mittel
10. **.apkg-Re-Import duplizierte alles** (kein GUID-Abgleich). → Anki-`guid` wird gelesen,
    vorhandene Notizen übersprungen; neuer `guid`-Index (Dexie v3); `decodeURIComponent`
    absturzsicher. *(apkg.ts, db.ts)*
11. **Anki-Konditionalfelder `{{#F}}`/`{{^F}}` und Feldfilter `{{type:}}`/`{{hint:}}`
    leckten/verschwanden** beim Rendern importierter Standardkarten. Beide korrekt behandelt. *(cardgen.ts)*
12. **Editor: `loaded`-Latch zeigte beim Wechsel `/edit/A → /edit/B` veraltete Felder**
    (Datenverlust-Risiko beim Speichern). Reload pro `noteId`. *(AddCard.tsx)*
13. **Editor erkannte/entfernte keine Bilder mit Attributen vor `src`** (z. B. aus Importen),
    obwohl Review sie rendert. Regex auf beliebige Attributreihenfolge erweitert. *(AddCard.tsx)*
14. **Doppelbewertung im optimistischen Review-Flow** (gehaltene Leertaste / schneller
    Doppeltipp → doppelter Revlog-Eintrag + übersprungene Folgekarte). Re-Entrancy-Guard
    pro Karten-ID, `e.repeat`-Block, Reload schließt bereits beantwortete Karten aus. *(Review.tsx)*
15. **Swipe-Geste las veralteten `drag`-State** → verschluckte schnelle Wischer. Live-Delta
    aus Ref. *(Review.tsx)*

### Niedrig / Härtung
16. Ziel-Retention defensiv geklemmt (verhindert FSRS-Crash bei korruptem Wert). *(api.ts)*
17. Medien-Download prüft jetzt, dass die Bytes zum angeforderten Hash passen. *(sync/media.ts)*
18. Wake-Lock wird bei System-Freigabe erneut angefordert + Unmount-Race entschärft. *(Review.tsx)*
19. Back-Link auch im Lade-/Hängezustand des Review (Ausweg aus dem Fokus-Modus). *(Review.tsx)*
20. PWA `navigateFallback: '/index.html'` (Offline-Deeplinks). *(vite.config.ts)*
21. Auto-Sync wird übersprungen, wenn `navigator.onLine === false`. *(App.tsx)*
22. Leeres/fehlendes `JWT_SECRET` blockt (500), Passwort-Maxlänge 1024, konstantzeitiger
    Hash-Vergleich. *(auth.ts)*

---

## Backlog — inzwischen vollständig abgearbeitet (Folge-Pass 29.06.)

- **Server-autoritatives LWW (B#5):** Konfliktauflösung jetzt per Inhalts-`updatedAt`
  (statt reiner Ankunftsreihenfolge); die Seq wird dabei IMMER hochgezählt, damit die
  gewinnende Version an alle Geräte propagiert (kein Hängenbleiben durch globale Seq).
  Lokal gegen D1 verifiziert (älter verliert + Seq steigt, neuer gewinnt).
- **`handlePush`-Atomarität (B#2):** change_log + sync_objects laufen jetzt in EINEM
  D1-`batch()` (eine Transaktion); seq via `last_insert_rowid()`. Verifiziert:
  `change_log.seq == sync_objects.seq`.
- **Sub-Deck-Traversierung (A#7):** `getStudyQueue` schließt Karten aller Unterdecks ein
  (parentId-Adjazenz). Verifiziert.
- **Verwaiste Medien-GC (D#5):** `gcOrphanedMedia()` nach Lösch-Operationen; geteilte Bilder
  bleiben erhalten. Verifiziert.
- **`exists` R2-Präsenz (D#8):** prüft echte R2-Bytes (head) statt bloßer D1-Zeile; ohne R2
  wird nichts als vorhanden gemeldet. Verifiziert.
- **Bild-Handling (D#6):** 25-MB-Eingabe-Cap, Rückmeldung bei Nicht-Bild-Dateien, animierte
  GIFs werden unverändert gespeichert (nicht flachgerendert).
- **Fuzz-konsistente Vorschau (A#5):** FSRS-Plan wird pro Karte EINMAL berechnet
  (`scheduleCard`) und für Anzeige UND Speichern (`commitReview`) verwendet — Button-Intervall
  = gespeichertes Intervall.
- **Stille Pull-Trunkierung (B#11):** wirft jetzt einen sichtbaren Fehler statt unbemerkt abzubrechen.
- **fmtInterval-Politur (A#9):** „fällig" für überfällige, saubere 24h-Grenze.
- **Toter Code (A#8):** ungenutzte `deckCounts`/`QueueCounts` entfernt.
- **Textauswahl vs. Swipe (E#6):** `user-select:none` während des Wischens.
- **Backup-Import-Outbox:** wiederhergestellte Daten werden in die Outbox eingereiht und
  synchronisieren nun (vorherige Einschränkung behoben). Verifiziert (Delta = Anzahl Objekte).

## Bewusst NICHT umgesetzt (mit Begründung)

- **Push-Cursor übernehmen (Tester B#3): ABGELEHNT.** Der Vorschlag, den Client-Cursor auf
  die vom Push zurückgegebenen Seqs vorzuziehen, würde Datenverlust verursachen: `change_log.seq`
  ist ein **global-monotoner** Zähler über alle Geräte *eines* Accounts; ein zweites Gerät,
  das zwischen erstem Pull und Push schreibt, bekäme niedrigere Seqs, die durch das Vorziehen
  übersprungen würden. Der „redundante" zweite Pull ist die korrekte, sichere Variante.

---

## Verifikation
- `npm run build` (App: `tsc -b` + Vite) — grün.
- `tsc -p tsconfig.worker.json --noEmit` — grün (Worker ist *nicht* Teil des Haupt-Builds).
- UI-Smoke-Test: Decks → Review (Aufdecken, FSRS-Vorschau 5min/10min/24h/2d, Bewerten →
  Queue rückt vor), Einstellungen (Import-Button rendert) — keine Konsolenfehler.
- Unit-Tests gegen echten Quellcode (dynamischer Import): CSV (5 Fälle), cardgen-Konditionale/
  Filter (5), Cloze-Regression (6), Backup-Roundtrip inkl. Datums-Revival, `newPerDay`-Limit.
