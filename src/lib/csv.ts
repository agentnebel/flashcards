// Robuster CSV/TSV-Parser: erkennt Trennzeichen, behandelt Anführungszeichen
// (inkl. ""-Escaping und Zeilenumbrüchen innerhalb von Feldern).

// Führendes UTF-8-BOM entfernen (Excel „CSV UTF-8" stellt U+FEFF voran).
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function detectDelimiter(text: string): string {
  const source = stripBom(text);
  let sample = source.slice(0, 5000);
  if (sample.length < source.length) {
    // Nur abgeschlossene Records bewerten. Ein abgeschnittenes letztes Feld würde
    // sonst die Spalten-Konsistenz des tatsächlichen Trennzeichens verschlechtern.
    let inQuotes = false;
    let lastRecordEnd = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === '"') {
        if (inQuotes && sample[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && (sample[i] === '\n' || sample[i] === '\r')) {
        lastRecordEnd = i + 1;
      }
    }
    if (lastRecordEnd > 0) sample = sample.slice(0, lastRecordEnd);
  }
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestScore = -Infinity;
  for (const delimiter of candidates) {
    const rows = parseDelimited(sample, delimiter);
    if (rows.length === 0) continue;
    const widths = rows.map((row) => row.length);
    // Ein gar nicht vorhandener Trenner liefert perfekt konsistente Einspalten-
    // Zeilen, ist aber kein Kandidat für eine Datei mit mehreren Feldern.
    if (!widths.some((width) => width > 1)) continue;
    const counts = new Map<number, number>();
    for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
    const [modeWidth, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    // Eine echte CSV-Spalte liefert über mehrere Zeilen dieselbe Breite. Häufige
    // Satzzeichen in Feldinhalten dagegen erzeugen meist uneinheitliche Zeilenbreiten.
    const score = modeCount * 100 + modeWidth;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
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
