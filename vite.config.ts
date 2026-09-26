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
              const featureName = featureMatch[1];
              if (featureName === 'inventory') {
                return `feature-inventory-${featureMatch[2]}`;
              }
              return `feature-${featureName}`;
            }

            if (id.includes(`${path.sep}src${path.sep}components${path.sep}common${path.sep}`)) {
              return 'common-components';
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
