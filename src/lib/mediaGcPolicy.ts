export const MEDIA_GC_GRACE_MS = 30 * 24 * 60 * 60_000;

export type MediaGcAction = 'keep' | 'rescue' | 'mark' | 'delete';

export function mediaGcAction(
  row: { sha256: string; orphanedAt: number | null },
  referenced: ReadonlySet<string>,
  now: number,
): MediaGcAction {
  if (referenced.has(row.sha256)) return row.orphanedAt === null ? 'keep' : 'rescue';
  if (row.orphanedAt === null) return 'mark';
  return row.orphanedAt <= now - MEDIA_GC_GRACE_MS ? 'delete' : 'keep';
}
