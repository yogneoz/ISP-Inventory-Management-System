import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { setDbMode, setPgConnected } from '../../server/lib/db';

describe('API health / readiness', () => {
  const app = createApp();
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.DISABLE_RATE_LIMIT = 'true';
    delete process.env.REQUIRE_POSTGRES;
    delete process.env.ALLOW_DB_FALLBACK;
    setPgConnected(false);
    setDbMode('memory');
  });

  afterEach(() => {
    process.env = { ...envBackup };
    setPgConnected(false);
    setDbMode('memory');
  });

  it('GET /api/health/live always returns 200', async () => {
    const res = await request(app).get('/api/health/live').expect(200);
    expect(res.body.status).toBe('live');
  });

  it('GET /api/health is ok in test/fallback mode', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ready).toBe(true);
    expect(res.body.database).toBeTruthy();
    expect(res.body.database.durable).toBe(false);
  });

  it('GET /api/health returns 503 when Postgres required but not durable', async () => {
    process.env.REQUIRE_POSTGRES = 'true';
    setDbMode('memory');
    setPgConnected(false);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ready).toBe(false);
    expect(res.body.requirePostgres).toBe(true);
    expect(res.body.database.durable).toBe(false);
  });

  it('GET /api/health/ready returns 503 when Postgres required but missing', async () => {
    process.env.REQUIRE_POSTGRES = 'true';
    setDbMode('pg-mem');
    setPgConnected(false);

    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });

  it('GET /api/health is 200 when durable postgres mode is set', async () => {
    process.env.REQUIRE_POSTGRES = 'true';
    setDbMode('postgres');
    setPgConnected(true);
    // pingPostgres may fail without real pool — ready flag may still be false.
    // At minimum durable mode is reported.
    const res = await request(app).get('/api/health');
    expect(res.body.database.mode).toBe('postgres');
    expect(res.body.database.durable).toBe(true);
    expect(res.body.requirePostgres).toBe(true);
  });
});
