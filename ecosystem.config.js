module.exports = {
  apps: [
    {
      name: 'enterprise-erp',
      // Single instance: in-memory sessions + JSON data store are not multi-process safe.
      // Scale horizontally only after moving sessions/state to Redis or PostgreSQL.
      script: 'dist/server.cjs',
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
