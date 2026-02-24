import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const serverPort = process.env.PORT ?? '8787';
const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? '5173', 10);
const resolvedClientPort = Number.isFinite(clientPort) && clientPort > 0 ? clientPort : 5173;

export default defineConfig({
  plugins: [preact()],
  server: {
    port: resolvedClientPort,
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
