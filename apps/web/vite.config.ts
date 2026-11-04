import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { BASE_PATH } from '../../packages/shared/src/schemas.ts';

const apiPort = process.env.REPNODE_PORT ?? '3210';

export default defineConfig({
  // Misma ruta que en producción detrás del proxy de IIS de PME (https://servidor/repnode/)
  base: `${BASE_PATH}/`,
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [`${BASE_PATH}/api`]: { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
});
