import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'media',
    emptyOutDir: false,
    lib: { entry: 'webview/app.tsx', name: 'DiCodeWebview', formats: ['iife'], fileName: () => 'bundle.js', cssFileName: 'style' },
  },
})
