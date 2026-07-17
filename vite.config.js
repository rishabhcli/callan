import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    headers: {
      'Origin-Agent-Cluster': '?1'
    },
    proxy: {
      '/api': `http://localhost:${process.env.PORT || 8787}`
    }
  }
});
