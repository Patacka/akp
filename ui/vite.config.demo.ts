import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build configuration for the read-only GitHub Pages demo.
// Deploy with: npm run build:demo
// Output goes to dist-demo/ which the gh-pages action picks up.
export default defineConfig({
  plugins: [react()],
  base: '/akp/',
  define: {
    'import.meta.env.VITE_DEMO': '"true"',
  },
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
  },
})
