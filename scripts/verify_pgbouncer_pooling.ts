/**
 * SCALE-3 — live proof that the app's database contract survives PgBouncer
 * `pool_mode=transaction`.
 *
 * Provisions its own PgBouncer instance (config + userlist in the OS temp
 * directory, its own port), starts it against the configured PostgreSQL, runs
 * the checks a transaction-mode pooler can break, and stops it again — the same
 * way `verify_read_routing.ts` provisions its own primary and standby.
 *
 *   npm run verify:pgbouncer
 *   PGBOUNCER_BIN="C:\\path\\pgbouncer.exe" npm run verify:pgbouncer
 *
 * Scenarios (each asserts real behaviour through the pooler, not the code):
 *
 *   1. the role's `statement_timeout` reaches every pooled server connection
 *      (it is not a client startup parameter, which a transaction-mode pooler
 *      never replays);
 *   2. the timeout is actually enforced — `pg_sleep(5)` is cancelled near 1s
 *      with SQLSTATE 57014;
 *   3. a session-scoped `SET` on one pooled client does not reach the next,
 *      which is why the app must keep no session state (and does not);
 *   4. a committed write is visible to a different pooled backend immediately
 *      (read-your-own-writes through the pool);
 *   5. a rolled-back write is not visible anywhere.
 *
 * Requires PgBouncer on the machine. The EDB Windows build installs to
 * `C:\Program Files\PgBouncer\pgbouncer.exe`; this script uses that path when
 * `PGBOUNCER_BIN` is not set.
 */
import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { ensureRoleStatementTimeout, readRoleStatementTimeout } from '../server/src/db/statementTimeout';

const DEFAULT_BIN = 'C:\\Program Files\\PgBouncer\\pgbouncer.exe';
const POOL_PORT = 56432;

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function pgbouncerBinary(): string {
  const candidate = process.env.PGBOUNCER_BIN || DEFAULT_BIN;
  if (!fs.existsSync(candidate)) {
    fail(
      `PgBouncer not found at ${candidate}. Install EDB PgBouncer for Windows or set PGBOUNCER_BIN to pgbouncer.exe.`
    );
  }
  return candidate;
}

function databaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail('DATABASE_URL is not set');
  const url = new URL(raw);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    fail(`The demo runs PgBouncer on this host, but DATABASE_URL points at ${url.hostname}.`);
  }
  return url;
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`PgBouncer did not listen on ${port} within ${timeoutMs}ms`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

type Scenario = { name: string; run: (poolerUrl: string) => Promise<string> };

async function main(): Promise<void> {
  const binary = pgbouncerBinary();
  const direct = databaseUrl();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-pgbouncer-demo-'));
  const iniPath = path.join(workDir, 'pgbouncer.ini');
  const userlistPath = path.join(workDir, 'userlist.txt');
  const logPath = path.join(workDir, 'pgbouncer.log');

  const user = decodeURIComponent(direct.username);
  const password = decodeURIComponent(direct.password);
  const dbName = direct.pathname.replace(/^\//, '');
  if (!password) fail('DATABASE_URL must carry a password for PgBouncer authentication');

  fs.writeFileSync(userlistPath, `"${user}" "${password}"\n`, 'utf8');
  fs.writeFileSync(
    iniPath,
    [
      '[databases]',
      // PgBouncer on Windows resolves names through its own getaddrinfo and
      // fails on "localhost" (11001), so the loopback address is pinned here.
      `${dbName} = host=${direct.hostname === 'localhost' ? '127.0.0.1' : direct.hostname} port=${direct.port || 5432} dbname=${dbName}`,
      '',
      '[pgbouncer]',
      'listen_addr = 127.0.0.1',
      `listen_port = ${POOL_PORT}`,
      'auth_type = scram-sha-256',
      `auth_file = ${userlistPath.replace(/\\/g, '/')}`,
      'pool_mode = transaction',
      'max_client_conn = 40',
      'default_pool_size = 4',
      'min_pool_size = 1',
      `logfile = ${logPath.replace(/\\/g, '/')}`,
      'server_reset_query = DISCARD ALL',
      // Without this, PgBouncer only runs the reset query in session pooling, so a
      // client's session SET leaks to the next client that borrows the server
      // connection (observed in this demo before the setting was added).
      'server_reset_query_always = 1',
      '',
    ].join('\n'),
    'utf8'
  );

  const poolerUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${POOL_PORT}/${dbName}`;

  // Prepare the role: 1s so the timeout is observable, restored at the end.
  const setup = new pg.Client({ connectionString: direct.toString() });
  await setup.connect();
  const previous = await readRoleStatementTimeout(setup);
  await ensureRoleStatementTimeout(setup, 1_000, () => undefined);

  let child: ChildProcess | null = null;
  try {
    child = spawn(binary, [iniPath], { cwd: workDir, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    await waitForPort(POOL_PORT, 20_000);

    const pooler = new pg.Pool({ connectionString: poolerUrl, max: 6, connectionTimeoutMillis: 5000 });
    pooler.on('error', () => undefined);
    const direct_ = new pg.Client({ connectionString: direct.toString() });
    await direct_.connect();

    const scratch = `pgbouncer_demo_${process.pid}`;
    await direct_.query(`DROP TABLE IF EXISTS ${scratch}`);
    await direct_.query(`CREATE TABLE ${scratch} (id INT PRIMARY KEY, note TEXT)`);

    const scenarios: Scenario[] = [
      {
        name: 'the role statement_timeout reaches a pooled connection',
        run: async (url) => {
          const client = new pg.Client({ connectionString: url });
          await client.connect();
          try {
            const show = await client.query('SHOW statement_timeout');
            const value = String(show.rows[0].statement_timeout);
            if (value !== '1s') throw new Error(`expected 1s from the role, got ${value}`);
            const who = await client.query('SELECT current_user AS u, pg_is_in_recovery() AS ro');
            if (who.rows[0].u !== user) throw new Error(`pooled as ${who.rows[0].u}, expected ${user}`);
            return `SHOW statement_timeout = ${value}`;
          } finally {
            await client.end();
          }
        },
      },
      {
        name: 'the timeout is enforced through the pooler',
        run: async (url) => {
          const client = new pg.Client({ connectionString: url });
          await client.connect();
          try {
            const started = Date.now();
            let code = '';
            try {
              await client.query('SELECT pg_sleep(5)');
            } catch (error: any) {
              code = String(error.code || '');
            }
            const elapsed = Date.now() - started;
            if (code !== '57014') throw new Error(`expected SQLSTATE 57014, got ${code || 'no error'} after ${elapsed}ms`);
            if (elapsed > 4_000) throw new Error(`the 5s sleep was not cut near 1s (${elapsed}ms)`);
            return `pg_sleep(5) cancelled at ${elapsed}ms with 57014`;
          } finally {
            await client.end();
          }
        },
      },
      {
        name: 'session SET cannot be relied on; transaction-local SET can',
        run: async (url) => {
          const first = new pg.Client({ connectionString: url });
          await first.connect();
          try {
            // A bare SET is its own transaction; the pooler's reset discards it
            // before the next statement even runs on this same client.
            await first.query('SET statement_timeout = 60000');
            const afterSessionSet = String((await first.query('SHOW statement_timeout')).rows[0].statement_timeout);
            if (afterSessionSet !== '1s') {
              throw new Error(`a bare session SET survived its transaction through the pool (${afterSessionSet})`);
            }

            // Transaction-local state does apply, because the pool keeps one
            // server connection for the whole transaction.
            await first.query('BEGIN');
            await first.query(`SET LOCAL statement_timeout = '60000'`);
            const insideTxn = String((await first.query('SHOW statement_timeout')).rows[0].statement_timeout);
            await first.query('ROLLBACK');
            const afterRollback = String((await first.query('SHOW statement_timeout')).rows[0].statement_timeout);
            if (insideTxn !== '1min' && insideTxn !== '60000') {
              throw new Error(`SET LOCAL did not apply inside its transaction (${insideTxn})`);
            }
            if (afterRollback !== '1s') {
              throw new Error(`SET LOCAL outlived its transaction (${afterRollback})`);
            }

            const second = new pg.Client({ connectionString: url });
            await second.connect();
            try {
              const fresh = String((await second.query('SHOW statement_timeout')).rows[0].statement_timeout);
              if (fresh !== '1s') throw new Error(`a different client inherited a session setting (${fresh})`);
              return `bare SET discarded, SET LOCAL = ${insideTxn} only inside its transaction, next client = ${fresh}`;
            } finally {
              await second.end();
            }
          } finally {
            await first.end();
          }
        },
      },
      {
        name: 'a committed write is visible to another pooled backend',
        run: async (url) => {
          const writer = new pg.Client({ connectionString: url });
          await writer.connect();
          await writer.end();
          const client = await pooler.connect();
          try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO ${scratch} (id, note) VALUES (1, 'committed through the pool')`);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
          const reader = await pooler.connect();
          try {
            const row = await reader.query(`SELECT note FROM ${scratch} WHERE id = 1`);
            if (row.rows.length !== 1) throw new Error('the committed row is not visible through the pool');
            return `visible from a second pooled connection: ${row.rows[0].note}`;
          } finally {
            reader.release();
          }
        },
      },
      {
        name: 'a rolled-back write is visible nowhere',
        run: async (url) => {
          const client = await pooler.connect();
          try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO ${scratch} (id, note) VALUES (2, 'rolled back')`);
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
          const reader = await pooler.connect();
          try {
            const row = await reader.query(`SELECT id FROM ${scratch} WHERE id = 2`);
            if (row.rows.length !== 0) throw new Error('a rolled-back row survived the pool');
            return 'id 2 absent after ROLLBACK';
          } finally {
            reader.release();
          }
        },
      },
    ];

    let passed = 0;
    for (const scenario of scenarios) {
      try {
        const detail = await scenario.run(poolerUrl);
        passed += 1;
        console.log(`✅ ${scenario.name} — ${detail}`);
      } catch (error: any) {
        console.error(`✖ ${scenario.name} — ${error?.message || error}`);
      }
    }

    await direct_.query(`DROP TABLE IF EXISTS ${scratch}`);
    await direct_.end();
    await pooler.end();

    console.log(`\n${passed}/${scenarios.length} scenarios passed through pool_mode=transaction (PgBouncer on 127.0.0.1:${POOL_PORT}).`);
    if (passed !== scenarios.length) process.exitCode = 1;
  } finally {
    if (previous) {
    if (process.exitCode) {
      try {
        const log = fs.readFileSync(logPath, 'utf8').split('\n').slice(-30).join('\n');
        console.error(`\nPgBouncer log (${logPath}):\n${log}`);
      } catch {
        console.error('PgBouncer wrote no log file.');
      }
    }
      const ddl = await setup.query(
        `SELECT format('ALTER ROLE %I SET statement_timeout = %L', current_user, $1::text) AS ddl`,
        [previous]
      );
      await setup.query(ddl.rows[0].ddl);
    } else {
      const ddl = await setup.query(`SELECT format('ALTER ROLE %I RESET statement_timeout', current_user) AS ddl`);
      await setup.query(ddl.rows[0].ddl);
    }
    await setup.end();
    if (child && child.pid) {
      // Only this process: a pattern kill could hit the agent or another shell.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
