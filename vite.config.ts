import { defineConfig } from 'vite';

const serverPort = process.env.PORT ?? '8787';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
