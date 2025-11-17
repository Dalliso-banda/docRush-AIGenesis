// vite.config.ts
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // 1. ADD BASE AND APP TYPE
      base: './', 
      appType: 'mpa', // <--- Disables SPA fallback for dev server
      
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      
      // 2. CONFIGURE ROLLUP INPUT
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            demo: path.resolve(__dirname, 'demo.html'), 
          },
        },
      },
      
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});