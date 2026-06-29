// Robuster CSV/TSV-Parser: erkennt Trennzeichen, behandelt Anführungszeichen
// (inkl. ""-Escaping und Zeilenumbrüchen innerhalb von Feldern).

// Führendes UTF-8-BOM entfernen (Excel „CSV UTF-8" stellt U+FEFF voran).
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Zählt ein Kandidaten-Trennzeichen nur außerhalb von Anführungszeichen.
function countOutsideQuotes(s: string, delim: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inQuotes && s[i + 1] === '"') { i++; continue; } // escaptes ""
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === delim) n++;
  }
  return n;
}

export function detectDelimiter(text: string): string {
  const sample = stripBom(text).slice(0, 5000);
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = countOutsideQuotes(sample, d);
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(text: string, delimiter: string): string[][] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (src[i + 1] === '\n') { i++; continue; } // \r\n: \r überspringen, \n beendet die Zeile
      endRow(); // alleinstehendes \r (klassisches Mac / manche Excel-Exporte) beendet die Zeile
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // letztes Feld/letzte Zeile
  if (field.length > 0 || row.length > 0) endRow();

  // komplett leere Zeilen entfernen
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function parseCsv(text: string, delimiter?: string): { delimiter: string; rows: string[][] } {
  const d = delimiter ?? detectDelimiter(text);
  return { delimiter: d, rows: parseDelimited(text, d) };
}
