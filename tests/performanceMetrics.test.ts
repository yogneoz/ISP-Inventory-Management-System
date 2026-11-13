import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile,
  performanceSnapshot,
  recordCacheRefresh,
  recordDbQuery,
  recordHttpRequest,
  recordPoolAcquire,
  resetPerformanceMetrics,
} from '../server/src/observability/metrics';
import { setSchemaVersionForTests } from '../server/src/boot/migrations';

describe('performance metrics registry', () => {
  test('computes nearest-rank percentiles for empty and populated samples', () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
  });

  test('aggregates request latency by route without unbounded cardinality', () => {
    resetPerformanceMetrics();
    recordHttpRequest('GET', '/api/customers/:id', 200, 10);
    recordHttpRequest('GET', '/api/customers/:id', 200, 30);
    recordHttpRequest('GET', '/api/customers/:id', 500, 50);

    const snapshot = performanceSnapshot();
    assert.equal(snapshot.requests.total, 3);
    assert.equal(snapshot.requests.errors, 1);
    assert.equal(snapshot.requests.p50Ms, 30);
    assert.equal(snapshot.requests.p95Ms, 50);
    assert.deepEqual(snapshot.requests.routes[0], {
      method: 'GET',
      route: '/api/customers/:id',
      count: 3,
      errorCount: 1,
      avgMs: 30,
      p50Ms: 30,
      p95Ms: 50,
      p99Ms: 50,
      maxMs: 50,
    });
  });

  test('reports pool wait, slow queries and cache refresh aggregates', () => {
    resetPerformanceMetrics();
    setSchemaVersionForTests('0002_phase0a_probe');
    recordPoolAcquire(12);
    recordPoolAcquire(40);
    recordPoolAcquire(200, true);
    recordDbQuery(900, 'SELECT * FROM customer_records WHERE branch_id = $1', true);
    recordDbQuery(5, 'SELECT 1', false);
    recordCacheRefresh(260, 28, [
      { name: 'customer_records', ms: 180 },
      { name: 'sales_invoices', ms: 40 },
    ]);

    const snapshot = performanceSnapshot();
    assert.equal(snapshot.schema.currentVersion, '0002_phase0a_probe');
    assert.equal(snapshot.database.queries, 2);
    assert.equal(snapshot.database.errors, 1);
    assert.equal(snapshot.database.poolAcquires, 3);
    assert.equal(snapshot.database.poolAcquireErrors, 1);
    assert.equal(snapshot.database.poolWaitMaxMs, 200);
    assert.equal(snapshot.database.slowQueryCount, 1);
    assert.match(snapshot.database.recentSlowQueries[0].sql, /customer_records/);
    assert.equal(snapshot.cacheRefresh.passes, 1);
    assert.equal(snapshot.cacheRefresh.slowPasses, 1);
    assert.equal(snapshot.cacheRefresh.maxMs, 260);
    assert.equal(snapshot.cacheRefresh.last?.slowest[0].name, 'customer_records');

    setSchemaVersionForTests(null);
  });
});
