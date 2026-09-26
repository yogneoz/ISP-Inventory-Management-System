import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // The frontend now lives in client/ (client/index.html + client/src/).
    root: 'client',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // Emit the built SPA to the project-root dist/ folder the Express
    // server serves in production (path.join(process.cwd(), 'dist')).
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              // NOTE: lucide-react must be matched BEFORE the generic 'react'
              // check — 'lucide-react' contains the substring 'react', so a
              // naive order lands every icon in vendor-react.
              if (id.includes('lucide-react')) return 'vendor-icons';
              if (id.includes('exceljs')) return 'vendor-excel';
              if (
                /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/.]/.test(id)
              ) {
                return 'vendor-react';
              }
              if (/[\\/]node_modules[\\/](motion|framer-motion)[\\/.]/.test(id)) {
                return 'vendor-motion';
              }
              return 'vendor';
            }

            const featureMatch = id.match(/[\\/]src[\\/]features[\\/]([^\\/]+)[\\/]([^\\/]+)\.(?:ts|tsx)$/);
            if (featureMatch) {
              // Per-file chunks for EVERY feature screen: a lazy-loaded screen
              // (React.lazy in App.tsx) then truly splits out of the startup
              // graph instead of riding in its feature-group chunk. Shared
              // helper modules referenced by several screens become their own
              // small chunks fetched in parallel.
              return `feature-${featureMatch[1]}-${featureMatch[2]}`;
            }

            // Shared components/util/hooks get their OWN file-level chunks.
            // Rollup otherwise merges a shared module into whichever chunk
            // first grabbed it (observed: DateField ended up inside the
            // FixedAssetRegister chunk, dragging a 40 kB finance screen into
            // every inventory screen's import graph). File-level chunks keep
            // each shared module a tiny parallel fetch.
            const sharedMatch = id.match(/[\\/]src[\\/](components|utils|hooks|contexts)[\\/](.+)\.(?:ts|tsx)$/);
            if (sharedMatch) {
              return `shared-${sharedMatch[2].replace(/[\\/]/g, '-')}`;
            }

            return undefined;
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
