import path from 'path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { PORT, syncDatabaseAndIndexes, createApp, registerAllRoutes } from './src/app';

async function startServer() {
  const app = createApp();

  // Register every domain router (plus the terminal error handler) BEFORE the
  // listener accepts requests — the original module-level registration ran
  // synchronously at startup, which is the same effective order.
  registerAllRoutes(app);

  await syncDatabaseAndIndexes();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Inventory Management System server running on http://localhost:${PORT}`);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

startServer().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
