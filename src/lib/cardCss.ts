const NESTED_RULE_AT_RULES = new Set(['media', 'supports', 'container', 'layer']);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findPreludeEnd(source: string, start: number): { index: number; token: '{' | ';' } | null {
  let quote = '';
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && (char === '{' || char === ';')) {
      return { index: i, token: char };
    }
  }
  return null;
}

function findBlockEnd(source: string, open: number): number {
  let depth = 1;
  let quote = '';
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let i = open + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && char === '{') depth++;
    else if (parentheses === 0 && brackets === 0 && char === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitSelectorList(source: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parentheses++;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(source.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(source.slice(start));
  return selectors;
}

function scopeSelector(selector: string, scope: string): string {
  let trimmed = selector.trim();
  if (!trimmed) return '';

  // Anki-CSS verwendet häufig html/body/:root als Kartenwurzel. Diese Selektoren
  // werden auf den lokalen Container abgebildet, nicht als globale Regeln erhalten.
  trimmed = trimmed.replace(/^(?:(?:html|body|:root)\s+)+/i, '');
  if (/^(?:html|body|:root)$/i.test(trimmed)) return scope;
  if (/^(?:html|body|:root)(?=[.#[:])/i.test(trimmed)) {
    return trimmed.replace(/^(?:html|body|:root)/i, scope);
  }
  return trimmed ? `${scope} ${trimmed}` : scope;
}

function scopeRules(source: string, scope: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /[\s;]/.test(source[cursor])) cursor++;
    if (cursor >= source.length) break;

    const end = findPreludeEnd(source, cursor);
    if (!end) break;
    const prelude = source.slice(cursor, end.index).trim();
    if (end.token === ';') {
      // Globale At-Rules wie @import/@namespace werden nie übernommen.
      cursor = end.index + 1;
      continue;
    }

    const close = findBlockEnd(source, end.index);
    if (close === -1) break;
    const body = source.slice(end.index + 1, close);
    cursor = close + 1;

    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      // Nur At-Rules, die weitere Selektorregeln kapseln, rekursiv übernehmen.
      // @font-face, @keyframes, @page, @property usw. sind global und werden verworfen.
      if (NESTED_RULE_AT_RULES.has(name)) {
        const nested = scopeRules(body, scope);
        if (nested) output += `${prelude}{${nested}}`;
      }
      continue;
    }

    const selectors = [...new Set(
      splitSelectorList(prelude)
        .map((selector) => scopeSelector(selector, scope))
        .filter(Boolean),
    )];
    if (selectors.length) output += `${selectors.join(',')}{${body}}`;
  }
  return output;
}

/**
 * Kapselt importiertes Anki-model.css unter einem lokalen Kartencontainer.
 * Globale At-Rules werden entfernt; @media/@supports/@container/@layer bleiben
 * erhalten, ihre inneren Selektoren werden rekursiv gekapselt.
 */
export function scopeImportedCardCss(css: string, scope = '.review-card'): string {
  if (!css.trim()) return '';
  if (!scope.trim() || /[{},]/.test(scope)) throw new Error('Ungültiger CSS-Scope');
  return scopeRules(stripComments(css), scope.trim());
}
