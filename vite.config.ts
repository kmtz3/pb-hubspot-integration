import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
  plugins: [react()],
  root: 'src/client',
  publicDir: '../../public',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_GCP_PROJECT_ID': JSON.stringify(env.GCP_PROJECT_ID ?? ''),
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/docs': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  };
});
