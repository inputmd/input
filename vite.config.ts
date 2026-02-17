import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const serverPort = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
