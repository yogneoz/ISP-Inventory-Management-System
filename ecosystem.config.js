module.exports = {
  apps: [
    {
      name: 'enterprise-erp',
      script: 'dist/server.cjs',
      // With Redis-backed sessions (REDIS_URL), cluster mode is safe for auth.
      // Domain JSON store (.data_store.json) is still single-writer — prefer
      // PostgreSQL as source of truth before scaling write-heavy workers.
      // Default remains 1; set instances via env PM2_INSTANCES or edit below
      // after Redis + Postgres are confirmed in production.
      instances: process.env.PM2_INSTANCES ? Number(process.env.PM2_INSTANCES) : 1,
      exec_mode: process.env.PM2_INSTANCES && Number(process.env.PM2_INSTANCES) > 1 ? 'cluster' : 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // REDIS_URL: 'redis://127.0.0.1:6379/0',
      },
      max_memory_restart: '1G',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
    },
  ],
};
