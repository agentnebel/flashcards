import { Marked } from 'marked';

// Eine einzige konfigurierte Marked-Instanz für die ganze App.
// - gfm: GitHub-Flavored Markdown (Tabellen, ~~durchgestrichen~~, Aufgabenlisten …)
// - breaks: ein einzelner Zeilenumbruch wird zu <br> (passt zum Karten-Authoring,
//   wo man selten Markdowns „zwei Leerzeichen am Zeilenende"-Regel erwartet)
//
// Wichtig: Marked reicht eingebettetes HTML unverändert durch. Dadurch bleiben sowohl
// die per Bild-Feature eingefügten <img src="flashmedia:HASH">-Tags als auch HTML aus
// .apkg-Importen erhalten – Markdown ist hier additiv, kein Bruch für Bestandskarten.
const marked = new Marked({ gfm: true, breaks: true });

/** Rendert einen Markdown-Feldwert zu HTML. Leerer Input → leerer String. */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  return marked.parse(src) as string;
}

// Grobe Markdown-Syntax für reine Text-Vorschauen (Browse-Liste) entfernen, damit dort
// nicht *Sternchen* und `Backticks` im Klartext auftauchen. Bewusst simpel gehalten.
export function stripMarkdown(src: string): string {
  return src
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) / ![alt](src) → text/alt
    .replace(/^#{1,6}\s+/gm, '') // Heading-Marker nur am Zeilenanfang ("C#" bleibt intakt)
    .replace(/^>\s?/gm, '') // Zitat-Marker nur am Zeilenanfang
    .replace(/[*_~`]/g, '') // Betonungs-/Code-Marker
    .replace(/^\s*[-+]\s+/gm, '') // Listen-Aufzählungszeichen
    .replace(/\s+/g, ' ')
    .trim();
}
