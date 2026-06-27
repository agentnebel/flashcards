import type { Note, NoteType } from '../db/db';

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

// Ersetzt {{Feld}}-Platzhalter; Feldnamen dürfen Unicode enthalten (z. B. "Rückseite").
function fill(tmpl: string, fields: Record<string, string>): string {
  return tmpl.replace(/\{\{([^{}]+)\}\}/g, (_all, raw: string) => fields[raw.trim()] ?? '');
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

// Rendert Vorder- und Rückseite einer konkreten Karte.
export function renderCard(
  note: Note,
  nt: NoteType,
  card: { templateOrd: number; clozeNum: number | null },
): { front: string; back: string } {
  if (nt.kind === 'cloze') {
    const text = note.fields[nt.fields[0]] ?? '';
    const extra = nt.fields[1] ? note.fields[nt.fields[1]] ?? '' : '';
    const num = card.clozeNum ?? 1;
    return {
      front: clozeRender(text, num, false),
      back: clozeRender(text, num, true) + (extra ? `<hr>${extra}` : ''),
    };
  }
  const tmpl = nt.templates[card.templateOrd] ?? nt.templates[0];
  const front = fill(tmpl.qfmt, note.fields);
  // {{FrontSide}} zuerst durch die gerenderte Vorderseite ersetzen, dann übrige Felder füllen.
  const back = fill(tmpl.afmt.replace(/\{\{FrontSide\}\}/g, front), note.fields);
  return { front, back };
}
