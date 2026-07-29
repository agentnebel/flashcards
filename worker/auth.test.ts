import { describe, expect, it, vi } from 'vitest';
import type { IRequest } from 'itty-router';
import { handleLogin, handleRegister } from './auth';
import type { Env } from './index';

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind: (...args: unknown[]) => FakeStatement;
  first: <T>() => Promise<T | null>;
}

function authRequest(body: Record<string, unknown>, ip = '203.0.113.10'): IRequest {
  return new Request('https://flashcards.test/api/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(body),
  }) as unknown as IRequest;
}

function fakeAuthEnv(inviteInitiallyAvailable: boolean) {
  let inviteAvailable = inviteInitiallyAvailable;
  let storedPasswordHash: string | null = null;
  let storedUserId: string | null = null;
  const preparedSql: string[] = [];
  const batch = vi.fn(async (statements: FakeStatement[]) => {
    const userInsert = statements[0];
    const inviteUpdate = statements[1];
    storedUserId = String(userInsert.args[0]);
    storedPasswordHash = String(userInsert.args[2]);
    inviteAvailable = false;
    return [
      { results: [{ id: storedUserId }] },
      { results: [{ token_hash: inviteUpdate.args[2] }] },
      { results: [] },
      { results: [] },
    ];
  });

  const prepare = vi.fn((sql: string): FakeStatement => {
    preparedSql.push(sql);
    const statement: FakeStatement = {
      sql,
      args: [],
      bind(...args: unknown[]) {
        statement.args = args;
        return statement;
      },
      async first<T>() {
        if (sql.includes('SELECT id FROM users')) return null;
        if (sql.includes('SELECT token_hash FROM registration_invites')) {
          return (inviteAvailable ? { token_hash: statement.args[0] } : null) as T | null;
        }
        if (sql.includes('AS users') && sql.includes('global_today')) {
          return { users: 0, global_today: 0, ip_today: 0 } as T;
        }
        if (sql.includes('SELECT id, email, password_hash FROM users')) {
          return (storedPasswordHash && storedUserId
            ? {
                id: storedUserId,
                email: 'person@example.com',
                password_hash: storedPasswordHash,
              }
            : null) as T | null;
        }
        return null;
      },
    };
    return statement;
  });

  const env = {
    JWT_SECRET: 'test-secret-with-at-least-16-characters',
    AUTH_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    DB: { prepare, batch },
  } as unknown as Env;

  return {
    env,
    batch,
    preparedSql,
    get inviteAvailable() {
      return inviteAvailable;
    },
  };
}

describe('fail-closed Registrierung mit Einmal-Einladung', () => {
  it('lehnt einen unbekannten Code vor Passwort-Hash und User-INSERT ab', async () => {
    const fake = fakeAuthEnv(false);

    const response = await handleRegister(authRequest({
      email: 'person@example.com',
      password: 'a-secure-password',
      inviteCode: 'unknown-invitation-code',
    }), fake.env);

    expect(response.status).toBe(403);
    expect(fake.batch).not.toHaveBeenCalled();
  });

  it('konsumiert nur den Hash im selben Batch und lässt bestehende Logins unverändert', async () => {
    const fake = fakeAuthEnv(true);
    const inviteCode = 'valid-one-time-invitation-code';
    const password = 'a-secure-password';

    const registerResponse = await handleRegister(authRequest({
      email: 'person@example.com',
      password,
      inviteCode,
    }), fake.env);

    expect(registerResponse.status).toBe(200);
    expect(fake.batch).toHaveBeenCalledOnce();
    const statements = fake.batch.mock.calls[0][0] as FakeStatement[];
    expect(statements[0].sql).toContain('EXISTS');
    expect(statements[1].sql).toContain('UPDATE registration_invites');
    expect(statements[1].sql).toContain('changes() > 0');
    expect(statements[1].args[2]).toHaveLength(43);
    expect(statements[1].args[2]).not.toBe(inviteCode);
    expect(JSON.stringify(statements.map(({ sql, args }) => ({ sql, args })))).not.toContain(inviteCode);
    expect(fake.inviteAvailable).toBe(false);

    const loginResponse = await handleLogin(authRequest({
      email: 'person@example.com',
      password,
    }), fake.env);

    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json() as { token?: unknown; user?: { email?: unknown } };
    expect(typeof loginBody.token).toBe('string');
    expect(loginBody.user?.email).toBe('person@example.com');
  });

  it('weist denselben Code nach erfolgreichem Verbrauch ab', async () => {
    const fake = fakeAuthEnv(true);
    const inviteCode = 'single-use-invitation-code';

    const first = await handleRegister(authRequest({
      email: 'person@example.com',
      password: 'a-secure-password',
      inviteCode,
    }), fake.env);
    const second = await handleRegister(authRequest({
      email: 'other@example.com',
      password: 'another-secure-password',
      inviteCode,
    }, '203.0.113.11'), fake.env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(fake.batch).toHaveBeenCalledOnce();
  });
});
