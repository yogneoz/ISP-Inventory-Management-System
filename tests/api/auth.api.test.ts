import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { initSessionStore } from '../../server/lib/sessionStore';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import { resetStoreForTests } from '../helpers/testStore';

describe('API auth & authorization', () => {
  const app = createApp();
  let adminPassword = 'TestAdmin@123';

  beforeEach(async () => {
    setPgConnected(false);
    setDbMode('memory');
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true, adminPassword });
    adminPassword = seeded.adminPassword;
  });

  it('GET /api/health is public and reports backends', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.sessions.backend).toBe('memory');
    expect(res.body.database).toBeTruthy();
    expect(['memory', 'pg-mem', 'postgres']).toContain(res.body.database.mode);
  });

  it('rejects protected routes without a Bearer token', async () => {
    await request(app).get('/api/bootstrap').expect(401);
    await request(app).get('/api/products').expect(401);
    await request(app).get('/api/users').expect(401);
  });

  it('rejects spoofed role headers without a session', async () => {
    await request(app)
      .get('/api/users')
      .set('x-user-role', 'SUPER_ADMIN')
      .set('x-user-email', 'evil@example.com')
      .expect(401);
  });

  it('rejects invalid login credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'wrong-password' })
      .expect(401);
    expect(res.body.message).toMatch(/invalid/i);
  });

  it('logs in, returns a token, and authorizes subsequent requests', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: adminPassword })
      .expect(200);

    expect(login.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(login.body.user.email).toBe('admin@test.local');
    expect(login.body.user.role).toBe('SUPER_ADMIN');
    expect(login.body.user.password).toBeUndefined();

    const token = login.body.token as string;

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.email).toBe('admin@test.local');

    const bootstrap = await request(app)
      .get('/api/bootstrap')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(bootstrap.body.branches)).toBe(true);
    expect(bootstrap.body.branches.length).toBeGreaterThan(0);
  });

  it('logout invalidates the session token', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: adminPassword })
      .expect(200);
    const token = login.body.token as string;

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .get('/api/bootstrap')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('setup-status reports whether a super admin exists', async () => {
    const withAdmin = await request(app).get('/api/auth/setup-status').expect(200);
    expect(withAdmin.body.hasSuperAdmin).toBe(true);

    await resetStoreForTests({ withAdmin: false });
    const empty = await request(app).get('/api/auth/setup-status').expect(200);
    expect(empty.body.isFirstLaunch).toBe(true);
    expect(empty.body.hasSuperAdmin).toBe(false);
  });
});
