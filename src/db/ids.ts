// UUID v4 (crypto). Server nutzt v7 für Zeitsortierung; clientseitig reicht v4,
// da Dexie ohnehin nach updatedAt/due indexiert.
export function uuid(): string {
  return crypto.randomUUID();
}
