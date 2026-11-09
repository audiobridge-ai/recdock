import { defineConfig } from 'vite';
import { createApplication } from './server/application.ts';

export default defineConfig({
  server: {
    host: 'localhost', port: 5173, strictPort: true,
    watch: { ignored: ['**/.local-audio/**', '**/worker/.venv/**', '**/__pycache__/**', '**/.pytest_cache/**'] },
    fs: { strict: true, deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.local-audio/**', '**/worker/.venv/**', '**/credentials*.json'] },
  },
  preview: { host: 'localhost' },
  plugins: [{
    name: 'plaud-local-login',
    configureServer(server) {
      const app = createApplication(); server.middlewares.use(app.middleware);
      server.httpServer?.once('close', () => { void app.close(); });
      const stop = () => { void app.close().finally(() => process.exit(0)); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    },
    configurePreviewServer(server) {
      const app = createApplication(); server.middlewares.use(app.middleware);
      server.httpServer.once('close', () => { void app.close(); });
      const stop = () => { void app.close().finally(() => process.exit(0)); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    },
  }],
});
