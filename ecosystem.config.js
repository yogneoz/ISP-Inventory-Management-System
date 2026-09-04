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
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
    },
  ],
};
