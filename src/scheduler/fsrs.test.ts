import { describe, expect, it } from 'vitest';
import { fmtInterval } from './fsrs';

const now = new Date('2026-07-02T12:00:00Z');
const inMs = (ms: number) => new Date(now.getTime() + ms);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('fmtInterval', () => {
  it('Vergangenheit/jetzt → "fällig"', () => {
    expect(fmtInterval(now, now)).toBe('fällig');
    expect(fmtInterval(inMs(-1), now)).toBe('fällig');
  });
  it('Minuten, mindestens 1', () => {
    expect(fmtInterval(inMs(30 * 1000), now)).toBe('1 min');
    expect(fmtInterval(inMs(30 * MIN), now)).toBe('30 min');
  });
  it('Stunden', () => {
    expect(fmtInterval(inMs(5 * HOUR), now)).toBe('5 Std');
  });
  it('23,6 h rundet zu 1 Tag statt 24 Std', () => {
    expect(fmtInterval(inMs(23.6 * HOUR), now)).toBe('1 T');
  });
  it('Tage und Monate', () => {
    expect(fmtInterval(inMs(3 * DAY), now)).toBe('3 T');
    expect(fmtInterval(inMs(60 * DAY), now)).toBe('2 Mon');
  });
  it('Jahre mit deutschem Dezimalkomma', () => {
    expect(fmtInterval(inMs(400 * DAY), now)).toBe('1,1 J');
  });
});
