import { describe, expect, it } from 'vitest';
import deployWorkflow from '../../.github/workflows/deploy.yml?raw';
import schema from '../../worker/schema.sql?raw';
import migration from '../../worker/migrations/0003_sync_quotas_media_gc.sql?raw';
import cleanupMigration from '../../worker/migrations/0004_finalize_sync_allocator.sql?raw';
import cleanupBatch from '../../worker/migrations/0005_cleanup_legacy_change_log_batch.sql?raw';
import inviteMigration from '../../worker/migrations/0006_registration_invites.sql?raw';
import authWorker from '../../worker/auth.ts?raw';
import syncWorker from '../../worker/sync.ts?raw';
import mediaWorker from '../../worker/media.ts?raw';

describe('D1-Schutzschema', () => {
  it('verwendet kompakte Cursorvergabe und harte Tagesbudgets', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS sync_counters');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS change_log');
    expect(schema).toContain('CREATE TRIGGER IF NOT EXISTS trg_change_log_compact');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS sync_object_usage');
    expect(schema).toContain('CREATE TRIGGER IF NOT EXISTS trg_sync_object_insert_usage');
    expect(schema).toContain('CREATE TRIGGER IF NOT EXISTS trg_media_insert_usage');
    expect(schema).toContain('mutations BETWEEN 0 AND 2000');
    expect(schema).toContain('mutations BETWEEN 0 AND 5000');
    expect(schema).toContain('sync_global_storage_bytes_limit');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS registration_invites');
  });

  it('verlangt atomar konsumierte, gehashte Einmal-Einladungen', () => {
    expect(inviteMigration).toContain('CREATE TABLE IF NOT EXISTS registration_invites');
    expect(inviteMigration).toContain('used_at IS NULL');
    expect(inviteMigration).toContain('LENGTH(token_hash) = 43');
    expect(authWorker).toContain("crypto.subtle.digest('SHA-256'");
    expect(authWorker).toContain('EXISTS (');
    expect(authWorker).toContain('UPDATE registration_invites');
    expect(authWorker).toContain('AND changes() > 0');
    expect(authWorker.indexOf('UPDATE registration_invites'))
      .toBeLessThan(authWorker.indexOf('INSERT INTO registration_daily_usage'));
  });

  it('migriert bestehende Cursor, Media-Quota und GC-Quarantäne rückwärtskompatibel', () => {
    expect(migration).toContain('INSERT INTO sync_counters');
    expect(migration).toContain('ALTER TABLE media ADD COLUMN orphaned_at INTEGER');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS sync_object_usage');
    expect(migration).toContain('CREATE TRIGGER IF NOT EXISTS trg_sync_object_insert_usage');
    expect(migration).toContain('CREATE TRIGGER IF NOT EXISTS trg_media_insert_usage');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS media_usage');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS media_gc_runs');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS media_gc_references');
    expect(migration).toContain('CREATE TRIGGER IF NOT EXISTS trg_change_log_compact');
    expect(migration).not.toContain('DROP TABLE IF EXISTS change_log');
    expect(cleanupMigration).toContain('INSERT INTO sync_counters');
    expect(cleanupMigration).not.toContain('DELETE FROM change_log');
    expect(cleanupMigration).not.toContain('DROP TABLE IF EXISTS change_log');
    expect(cleanupBatch).toContain('LIMIT 1000');
    expect(cleanupBatch).toContain('EXISTS(SELECT 1 FROM change_log LIMIT 1) AS has_more');
    expect(cleanupBatch).not.toContain('COUNT(*)');
  });

  it('reserviert auch für leere Pulls einen festen Block vor der Objektabfrage', () => {
    expect(syncWorker).toContain('PULL_REQUEST_BUDGET_BLOCK = 4');
    expect(syncWorker.indexOf('reservePullBudget(env, req.userId, PULL_REQUEST_BUDGET_BLOCK'))
      .toBeLessThan(syncWorker.indexOf('SELECT entity, entity_id, payload, deleted, seq'));
    expect(syncWorker).toContain('selectedRows.length - PULL_REQUEST_BUDGET_BLOCK');
  });

  it('verteilt nur den serverseitig gekappten LWW-Zeitstempel an andere Clients', () => {
    expect(syncWorker).toContain('return Math.min(raw, now)');
    expect(syncWorker).not.toContain('FUTURE_CLOCK_SKEW_MS');
    expect(syncWorker).toContain('{ ...mutation.payload, updatedAt }');
    expect(syncWorker.indexOf('const normalizedMutations'))
      .toBeLessThan(syncWorker.indexOf('JSON.stringify(payload)'));
  });

  it('räumt große GC-Referenz-Snapshots in einer eigenen paginierten Phase auf', () => {
    expect(schema).toContain("'cleanup'");
    expect(migration).toContain("'cleanup'");
    expect(mediaWorker).toContain("claimed.phase === 'cleanup'");
    expect(mediaWorker).toContain('GC_REFERENCE_CLEANUP_PAGE_SIZE');
    expect(mediaWorker).not.toContain(
      "DELETE FROM media_gc_references WHERE user_id = ?').bind(req.userId)",
    );
    expect(mediaWorker).not.toMatch(/complete:\s*true,\s*deferred:\s*true/);
  });

  it('deployt Worker-Code erst nach bestätigter Remote-Schema-Version 4', () => {
    expect(deployWorkflow).toContain('FLASHCARDS_SCHEMA_VERSION');
    expect(deployWorkflow).toContain('FLASHCARDS_SCHEMA_VERSION\" == \"4');
    expect(deployWorkflow.indexOf('Check deployment preconditions'))
      .toBeLessThan(deployWorkflow.indexOf('Deploy Worker + Assets'));
  });
});
