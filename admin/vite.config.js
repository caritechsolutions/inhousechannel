import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the Node server under /admin. In dev, API calls are proxied to a running server
// (server/ listens on 127.0.0.1:3100; override with VITE_DEV_TARGET).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    fs: { allow: ['..'] },   // shared/ lives one level up
    proxy: {
      '/api': { target: process.env.VITE_DEV_TARGET || 'http://127.0.0.1:3100', changeOrigin: false },
      '/media': { target: process.env.VITE_DEV_TARGET || 'http://127.0.0.1:3100', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
