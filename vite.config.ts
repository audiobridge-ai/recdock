import { defineConfig } from 'vite';
import { createCloudMiddleware } from './server/http.ts';

export default defineConfig({
  server: { host: 'localhost', port: 5173, strictPort: true },
  preview: { host: 'localhost' },
  plugins: [{
    name: 'plaud-local-login',
    configureServer(server) { server.middlewares.use(createCloudMiddleware()); },
    configurePreviewServer(server) { server.middlewares.use(createCloudMiddleware()); },
  }],
});
