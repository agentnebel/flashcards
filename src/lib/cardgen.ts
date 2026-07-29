import type { Note, NoteType } from '../db/db';
import { renderMarkdown } from './markdown';
import { sanitizeHtml } from './sanitize';

export interface CardSpec {
  templateOrd: number;
  clozeNum: number | null;
}

interface FieldReference {
  name: string;
  filters: string[];
}

// Welche Cloze-Nummern kommen im Text vor? ({{c1::...}}, {{c2::...}})
export function clozeNumbers(text: string): number[] {
  const set = new Set<number>();
  const re = /\{\{c(\d+)::/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(parseInt(m[1], 10));
  return [...set].sort((a, b) => a - b);
}

function parseFieldReference(raw: string): FieldReference {
  const parts = raw.split(':').map((part) => part.trim());
  return {
    name: parts.pop() ?? '',
    filters: parts.map((filter) => filter.toLowerCase()),
  };
}

function clozeFieldNames(nt: NoteType): string[] {
  const names = new Set<string>();
  const templates = nt.templates.length ? nt.templates : [{ name: '', qfmt: '', afmt: '' }];
  for (const template of templates) {
    for (const source of [template.qfmt, template.afmt]) {
      for (const match of source.matchAll(/\{\{([^{}#^/][^{}]*)\}\}/g)) {
        const ref = parseFieldReference(match[1]);
        if (ref.filters.includes('cloze') && ref.name) names.add(ref.name);
      }
    }
  }
  return [...names];
}

const MEANINGFUL_FRONT_TAG_RE = /<(?:img|audio|video|svg|canvas|object|embed)\b/i;

// Prüft, ob ein Vorderseiten-Template für die gegebenen Feldwerte etwas anderes als Tags/
// Whitespace ergäbe. Medien-Tags zählen als Inhalt: eine Bild-only-Karte ist beantwortbar.
// Anki erzeugt pro Template nur dann eine Karte, wenn dessen gerenderte Vorderseite nicht leer
// ist — sonst entstünde eine leere, unbeantwortbare Karte (z. B. beim "optional umgekehrte
// Karte"-Template, solange das Umkehr-Flag-Feld leer ist).
function frontHasContent(qfmt: string, fields: Record<string, string>): boolean {
  const front = fill(qfmt, fields);
  return MEANINGFUL_FRONT_TAG_RE.test(front) || front.replace(/<[^>]*>/g, '').trim() !== '';
}

// Aus einer Notiz werden 1..n Karten erzeugt (Templates bzw. Cloze-Deletions).
export function generateCards(note: Note, nt: NoteType): CardSpec[] {
  if (nt.kind === 'cloze') {
    // Importierte Anki-Cloze-Typen können das Lückenfeld an beliebiger Position haben.
    // Maßgeblich ist der {{cloze:Feld}}-Filter im Template; Feld 0 bleibt nur der
    // Kompatibilitäts-Fallback für alte/lückenhafte lokale Notiztypen.
    const sourceFields = clozeFieldNames(nt);
    const fields = sourceFields.length ? sourceFields : nt.fields.slice(0, 1);
    const nums = [...new Set(fields.flatMap((field) => clozeNumbers(note.fields[field] ?? '')))]
      .sort((a, b) => a - b);
    if (nums.length === 0) return [{ templateOrd: 0, clozeNum: 1 }];
    return nums.map((n) => ({ templateOrd: 0, clozeNum: n }));
  }
  return nt.templates
    .map((t, i) => ({ templateOrd: i, clozeNum: null as number | null, qfmt: t.qfmt }))
    .filter((s) => frontHasContent(s.qfmt, note.fields))
    .map(({ templateOrd, clozeNum }) => ({ templateOrd, clozeNum }));
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
  renderValue: (value: string, ref: FieldReference) => string = (value) => value,
): string {
  return applyConditionals(tmpl, fields).replace(/\{\{([^{}#^/][^{}]*)\}\}/g, (_all, raw: string) => {
    const ref = parseFieldReference(raw);
    return renderValue(fields[ref.name] ?? '', ref);
  });
}

function renderStandardField(
  value: string,
  ref: FieldReference,
  face: 'front' | 'back',
): string {
  if (ref.filters.includes('type')) {
    return face === 'front'
      ? '<input class="type-answer" type="text" autocomplete="off" aria-label="Antwort eingeben">'
      : `<span class="type-answer-correct">${renderMarkdown(value)}</span>`;
  }
  if (ref.filters.includes('hint')) {
    return `<details class="hint"><summary>Hinweis anzeigen</summary><div>${renderMarkdown(value)}</div></details>`;
  }
  return renderMarkdown(value);
}

function typedAnswerFromTemplate(
  template: string,
  fields: Record<string, string>,
): string | null {
  const renderedTemplate = applyConditionals(template, fields);
  for (const match of renderedTemplate.matchAll(/\{\{([^{}#^/][^{}]*)\}\}/g)) {
    const ref = parseFieldReference(match[1]);
    if (ref.filters.includes('type')) return fields[ref.name] ?? '';
  }
  return null;
}

const FRONT_SIDE_TOKEN = '\uE000FLASHCARDS_FRONT_SIDE\uE001';

function insertFrontSide(template: string, front: string): string {
  return template
    .replace(/\{\{\s*FrontSide\s*\}\}/g, FRONT_SIDE_TOKEN)
    .replaceAll(FRONT_SIDE_TOKEN, front);
}

function clozeRender(text: string, num: number, reveal: boolean): string {
  return text.replace(
    /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g,
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
): { front: string; back: string; typeAnswer?: string } {
  if (nt.kind === 'cloze') {
    const num = card.clozeNum ?? 1;
    const fallbackField = clozeFieldNames(nt)[0] ?? nt.fields[0] ?? 'Text';
    const fallbackTemplate = {
      name: 'Cloze',
      qfmt: `{{cloze:${fallbackField}}}`,
      afmt: `{{cloze:${fallbackField}}}`,
    };
    const selected = nt.templates[card.templateOrd] ?? nt.templates[0];
    const tmpl = selected && (selected.qfmt || selected.afmt) ? selected : fallbackTemplate;
    const renderTemplate = (source: string, reveal: boolean): string =>
      fill(source, note.fields, (value, ref) =>
        renderMarkdown(ref.filters.includes('cloze') ? clozeRender(value, num, reveal) : value),
      );

    // qfmt/afmt sind der Vertrag des importierten Notiztyps: Zusatzfelder erscheinen nur
    // dort, wo das Template sie platziert. {{FrontSide}} übernimmt die vollständig gerenderte
    // Vorderseite; der Funktions-Replacer schützt auch hier vor "$"-Ersetzungsmustern.
    const front = renderTemplate(tmpl.qfmt, false);
    const backTemplate = tmpl.afmt.replace(/\{\{\s*FrontSide\s*\}\}/g, FRONT_SIDE_TOKEN);
    const back = insertFrontSide(renderTemplate(backTemplate, true), front);
    return {
      front: sanitizeHtml(front),
      back: sanitizeHtml(back),
    };
  }
  const tmpl = nt.templates[card.templateOrd] ?? nt.templates[0];
  const front = fill(
    tmpl.qfmt,
    note.fields,
    (value, ref) => renderStandardField(value, ref, 'front'),
  );
  // FrontSide erst NACH dem Füllen einsetzen. Sonst würden literal vorkommende
  // "{{…}}" aus dem bereits gerenderten Vorderseiteninhalt als Template erneut geparst.
  const backTemplate = tmpl.afmt.replace(/\{\{\s*FrontSide\s*\}\}/g, FRONT_SIDE_TOKEN);
  const back = insertFrontSide(
    fill(
      backTemplate,
      note.fields,
      (value, ref) => renderStandardField(value, ref, 'back'),
    ),
    front,
  );
  const typeAnswer = typedAnswerFromTemplate(tmpl.qfmt, note.fields);
  return {
    front: sanitizeHtml(front),
    back: sanitizeHtml(back),
    ...(typeAnswer === null ? {} : { typeAnswer }),
  };
}
