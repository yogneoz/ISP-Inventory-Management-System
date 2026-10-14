module.exports = {
  apps: [
    {
      name: 'enterprise-erp',
      script: 'dist/server.cjs',
      // Runtime sessions, caches, and SSE clients are process-local. Run one
      // worker until those concerns are moved to shared infrastructure.
      instances: 1,
      exec_mode: 'fork',
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
