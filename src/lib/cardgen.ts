import type { Note, NoteType } from '../db/db';
import { renderMarkdown } from './markdown';
import { sanitizeHtml } from './sanitize';

export interface CardSpec {
  templateOrd: number;
  clozeNum: number | null;
}

// Welche Cloze-Nummern kommen im Text vor? ({{c1::...}}, {{c2::...}})
export function clozeNumbers(text: string): number[] {
  const set = new Set<number>();
  const re = /\{\{c(\d+)::/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(parseInt(m[1], 10));
  return [...set].sort((a, b) => a - b);
}

// Aus einer Notiz werden 1..n Karten erzeugt (Templates bzw. Cloze-Deletions).
export function generateCards(note: Note, nt: NoteType): CardSpec[] {
  if (nt.kind === 'cloze') {
    const text = note.fields[nt.fields[0]] ?? '';
    const nums = clozeNumbers(text);
    if (nums.length === 0) return [{ templateOrd: 0, clozeNum: 1 }];
    return nums.map((n) => ({ templateOrd: 0, clozeNum: n }));
  }
  return nt.templates.map((_, i) => ({ templateOrd: i, clozeNum: null }));
}

// Anki-Konditionalfelder auflösen: {{#F}}…{{/F}} nur bei nicht-leerem Feld F,
// {{^F}}…{{/F}} nur bei leerem F. Mehrere Durchläufe für verschachtelte Abschnitte.
function applyConditionals(tmpl: string, fields: Record<string, string>): string {
  const re = /\{\{([#^])([^{}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
  let out = tmpl;
  let prev: string;
  do {
    prev = out;
    out = out.replace(re, (_all, kind: string, rawName: string, inner: string) => {
      const filled = (fields[rawName.trim()] ?? '').trim() !== '';
      const keep = kind === '#' ? filled : !filled;
      return keep ? inner : '';
    });
  } while (out !== prev);
  return out;
}

// Ersetzt {{Feld}}-Platzhalter; Feldnamen dürfen Unicode enthalten (z. B. "Rückseite").
// Anki-Feldfilter wie {{type:Feld}}, {{hint:Feld}}, {{cloze:Feld}} werden auf den
// reinen Feldwert reduziert (Teil nach dem letzten Doppelpunkt).
// `renderValue` transformiert den eingesetzten Feldwert (hier: Markdown→HTML). Bereits
// ersetztes {{FrontSide}} (fertiges HTML) durchläuft fill NICHT erneut und bleibt unberührt.
function fill(
  tmpl: string,
  fields: Record<string, string>,
  renderValue: (s: string) => string = (s) => s,
): string {
  return applyConditionals(tmpl, fields).replace(/\{\{([^{}#^/][^{}]*)\}\}/g, (_all, raw: string) => {
    let name = raw.trim();
    const colon = name.lastIndexOf(':');
    if (colon !== -1) name = name.slice(colon + 1).trim();
    return renderValue(fields[name] ?? '');
  });
}

function clozeRender(text: string, num: number, reveal: boolean): string {
  return text.replace(
    /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g,
    (_all, n: string, ans: string, hint?: string) => {
      if (parseInt(n, 10) === num) {
        return reveal
          ? `<span class="cloze">${ans}</span>`
          : `<span class="cloze">[${hint || '...'}]</span>`;
      }
      return ans; // andere Cloze-Lücken werden offen gezeigt
    },
  );
}

// Rendert Vorder- und Rückseite einer konkreten Karte. Das fertige HTML wird IMMER
// sanitisiert (DOMPurify): Felder UND Templates können aus fremden .apkg-Dateien oder dem
// Sync stammen — eingebettetes Skript (z. B. <img onerror=…>) darf nie im App-Origin laufen.
export function renderCard(
  note: Note,
  nt: NoteType,
  card: { templateOrd: number; clozeNum: number | null },
): { front: string; back: string } {
  if (nt.kind === 'cloze') {
    const text = note.fields[nt.fields[0]] ?? '';
    const extra = nt.fields[1] ? note.fields[nt.fields[1]] ?? '' : '';
    const num = card.clozeNum ?? 1;
    // Cloze-Lücken zuerst zu <span class="cloze">…</span> auflösen, dann Markdown anwenden.
    // Marked reicht die fertigen Spans durch und rendert Markdown im umgebenden Text.
    return {
      front: sanitizeHtml(renderMarkdown(clozeRender(text, num, false))),
      back: sanitizeHtml(
        renderMarkdown(clozeRender(text, num, true)) + (extra ? `<hr>${renderMarkdown(extra)}` : ''),
      ),
    };
  }
  const tmpl = nt.templates[card.templateOrd] ?? nt.templates[0];
  const front = fill(tmpl.qfmt, note.fields, renderMarkdown);
  // {{FrontSide}} zuerst durch die gerenderte Vorderseite ersetzen, dann übrige Felder füllen.
  const back = fill(tmpl.afmt.replace(/\{\{FrontSide\}\}/g, front), note.fields, renderMarkdown);
  return { front: sanitizeHtml(front), back: sanitizeHtml(back) };
}
