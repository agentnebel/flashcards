import DOMPurify from 'dompurify';

// Karteninhalte sind potenziell fremder Input: .apkg-Decks aus dem Netz, gesyncte Felder,
// eingefügtes HTML. Ohne Sanitizing könnte ein <img onerror=…> oder <script> im App-Origin
// Skript ausführen — und damit z. B. das Auth-Token aus IndexedDB auslesen (Konto-Übernahme).
// DOMPurify entfernt Skripte und Event-Handler, lässt HTML-Struktur, Styles, Klassen
// (z. B. die Cloze-Spans) und Bilder durch.
//
// ALLOWED_URI_REGEXP = DOMPurify-Standard + eigene Schemata: flashmedia: (Platzhalter für
// lokale Bilder, wird NACH dem Sanitizing per resolveMediaHtml zu blob:-URLs aufgelöst)
// sowie blob: und data: (bereits aufgelöste bzw. eingebettete Bilder).
const URI_RE = /^(?:(?:https?|mailto|tel|flashmedia|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// <form> braucht keine Karte, ermöglicht aber Phishing-Attrappen in importierten Decks.
// Die CSP (form-action 'self') fängt Submits zwar ab — das Tag selbst hat trotzdem nichts
// in Karteninhalten verloren. <input> bleibt erlaubt (type-answer-Karten).
const FORBID_TAGS = ['form'];

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: URI_RE, FORBID_TAGS });
}
