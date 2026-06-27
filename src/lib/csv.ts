// Robuster CSV/TSV-Parser: erkennt Trennzeichen, behandelt Anführungszeichen
// (inkl. ""-Escaping und Zeilenumbrüchen innerhalb von Feldern).

export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 5000).split('\n').slice(0, 20).join('\n');
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    // Nur Trennzeichen außerhalb von Quotes grob zählen reicht zur Erkennung.
    const count = sample.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(text: string, delimiter: string): string[][] {
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

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
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
