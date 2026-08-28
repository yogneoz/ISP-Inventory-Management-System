import { describe, it, expect, beforeEach } from 'vitest';
import {
  initSessionStore,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
  getSessionBackend,
  getSessionStoreStats,
} from '../../server/lib/sessionStore';

const sampleUser = {
  id: 'usr-1',
  email: 'user@test.local',
  name: 'Test User',
  role: 'BRANCH_MANAGER',
  branchId: 'WH001',
  canSwitchUser: false,
};

describe('sessionStore (memory backend)', () => {
  beforeEach(async () => {
    // Ensure clean memory mode (no REDIS_URL in test setup)
    await initSessionStore();
    expect(getSessionBackend()).toBe('memory');
  });

  it('creates a session with a 64-char hex token', async () => {
    const session = await createSession(sampleUser);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(session.userId).toBe('usr-1');
    expect(session.email).toBe('user@test.local');
    expect(session.role).toBe('BRANCH_MANAGER');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(session.rootUserId).toBe('usr-1');
  });

  it('retrieves an active session and slides expiry', async () => {
    const created = await createSession(sampleUser);
    const first = await getSession(created.token);
    expect(first?.email).toBe(sampleUser.email);

    const exp1 = first!.expiresAt;
    // small delay so sliding expiry moves forward
    await new Promise((r) => setTimeout(r, 5));
    const second = await getSession(created.token);
    expect(second?.expiresAt).toBeGreaterThanOrEqual(exp1);
  });

  it('returns null for missing or destroyed tokens', async () => {
    expect(await getSession(null)).toBeNull();
    expect(await getSession('')).toBeNull();
    expect(await getSession('deadbeef'.repeat(8))).toBeNull();

    const session = await createSession(sampleUser);
    await destroySession(session.token);
    expect(await getSession(session.token)).toBeNull();
  });

  it('destroyUserSessions removes all tokens for a user', async () => {
    const a = await createSession(sampleUser);
    const b = await createSession(sampleUser);
    const other = await createSession({
      ...sampleUser,
      id: 'usr-2',
      email: 'other@test.local',
    });

    await destroyUserSessions('usr-1');
    expect(await getSession(a.token)).toBeNull();
    expect(await getSession(b.token)).toBeNull();
    expect(await getSession(other.token)).not.toBeNull();

    await destroySession(other.token);
  });

  it('preserves rootUserId when profile-switching', async () => {
    const session = await createSession(
      { ...sampleUser, id: 'usr-front', email: 'front@test.local', role: 'FRONT_DESK' },
      'usr-root'
    );
    expect(session.rootUserId).toBe('usr-root');
    const loaded = await getSession(session.token);
    expect(loaded?.rootUserId).toBe('usr-root');
    expect(loaded?.userId).toBe('usr-front');
  });

  it('reports memory backend stats', async () => {
    await createSession(sampleUser);
    const stats = await getSessionStoreStats();
    expect(stats.backend).toBe('memory');
    expect(stats.memoryCount).toBeGreaterThanOrEqual(1);
  });
});
