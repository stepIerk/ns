import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// base './' — относительные пути к ассетам, чтобы фронт работал
// и на Vercel (корень), и на GitHub Pages (подпуть /<repo>/).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    // Офлайн-шелл PWA: прекэш index.html/JS/CSS в SW (injectManifest собирает
    // наш public/sw.js через esbuild и подставляет __WB_MANIFEST).
    // Регистрацией занимается registerSW() вручную (нужен ранний mount под iOS),
    // манифест свой — поэтому injectRegister и manifest выключены.
    // Runtime-кэширования API/Firestore НЕТ: запросы данных всегда идут в сеть
    // (а при офлайне — в IDB-зеркала), SW их не перехватывает.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      injectRegister: false,
      manifest: false,
    }),
  ],
})
