module.exports = {
  apps: [
    {
      name: 'enterprise-erp',
      script: 'dist/server.cjs',
      // Horizontal workers. SCALE-1 moved auth/SSE limits, session revocation,
      // process-wide locks and SSE fan-out to Redis. REDIS_URL (or
      // REDIS_TLS_URL) is required in production; the boot guard refuses a
      // clustered process without it. Local reference caches are per-worker and
      // are refreshed from PostgreSQL; SCALE-4 replaces them with a shared cache.
      // See README.md, "Horizontal workers and shared state".
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      max_memory_restart: '1G',
      // The graceful drain in server/src/boot/lifecycle.ts stops accepting, lets
      // in-flight requests finish, closes the pool and exits 0. pm2's default
      // (1600ms) SIGKILLs before that can happen on any slow request, so it must
      // exceed SHUTDOWN_TIMEOUT_MS (default 10s) with room for the pool close.
      kill_timeout: 15000,
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
    },
  ],
};
