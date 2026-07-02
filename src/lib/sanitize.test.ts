import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml', () => {
  it('entfernt <script>', () => {
    expect(sanitizeHtml('a<script>alert(1)</script>b')).toBe('ab');
  });
  it('entfernt Inline-Event-Handler', () => {
    const out = sanitizeHtml('<img src="flashmedia:aa11" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).toContain('flashmedia:aa11');
  });
  it('erlaubt flashmedia:-, blob:- und data:-URLs', () => {
    expect(sanitizeHtml('<img src="flashmedia:ff00">')).toContain('src="flashmedia:ff00"');
    expect(sanitizeHtml('<img src="blob:https://x/y">')).toContain('src="blob:');
    expect(sanitizeHtml('<img src="data:image/png;base64,AA==">')).toContain('src="data:');
  });
  it('entfernt javascript:-Links', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });
  it('behält Struktur, Klassen und Styles', () => {
    const out = sanitizeHtml('<span class="cloze" style="color:red">x</span>');
    expect(out).toContain('class="cloze"');
    expect(out).toContain('x');
  });
  it('leerer Input → leerer String', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});
