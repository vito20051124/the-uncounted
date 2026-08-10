import { defineConfig } from 'vite'

// The Uncounted / 無籍者 — P0
// 全離線、無 CDN：所有依賴皆打包進產物，不從外部載入任何資源。
export default defineConfig({
  base: './',
  server: {
    port: 4174, // codex/ 佔用 4173
    strictPort: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // 單一 chunk，便於離線交付
        manualChunks: undefined,
      },
    },
  },
})
