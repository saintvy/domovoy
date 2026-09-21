import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadLocalPublicConfig } from './scripts/local-config';
function localRuntimeConfig(): Plugin {
  return {
    name: 'brownie-local-public-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/runtime-config.json', (_request, response) => {
        try {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(loadLocalPublicConfig()));
        } catch {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(
            JSON.stringify({
              error:
                'Configure infra/runtime-config.local.json with the real local Cognito app client. See docs/local-development.md.',
            }),
          );
        }
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), localRuntimeConfig()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target:
          'http://127.0.0.1:' + Number(process.env.BROWNIE_LOCAL_PORT ?? 8787),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom/client', 'dexie', 'zod'] },
      },
    },
  },
});
