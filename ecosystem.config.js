module.exports = {
  apps: [
    {
      name: 'enterprise-erp',
      script: 'dist/server.cjs',
      // Only raise PM2_INSTANCES after REDIS_URL is set (sessions + SSE).
      instances: process.env.PM2_INSTANCES ? Number(process.env.PM2_INSTANCES) : 1,
      exec_mode: process.env.PM2_INSTANCES && Number(process.env.PM2_INSTANCES) > 1 ? 'cluster' : 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Fail closed: do not start without Postgres
        REQUIRE_POSTGRES: 'true',
        REQUIRE_MIGRATIONS: 'true',
        // ALLOW_DB_FALLBACK: 'false',
        // REDIS_URL: 'redis://127.0.0.1:6379/0',
        TRUST_PROXY: 'true',
        LOG_LEVEL: 'info',
        STRICT_PASSWORD_POLICY: 'true',
        SEED_DUMMY_DATA: 'false',
      },
      max_memory_restart: '1G',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      // Give Postgres a moment on host reboot
      exp_backoff_restart_delay: 2000,
      max_restarts: 10,
    },
  ],
};
