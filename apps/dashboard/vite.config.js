import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import inject from '@rollup/plugin-inject'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      process: 'process/browser',
      buffer: 'buffer',
    },
  },
  define: {
    'process.env': {},
  },
  optimizeDeps: {
    include: ['process', 'buffer'],
  },
  build: {
    rollupOptions: {
      plugins: [
        inject({
          process: 'process',
          Buffer: ['buffer', 'Buffer'],
        }),
      ],
    },
  },
})
