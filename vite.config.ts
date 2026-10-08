import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// base './' — относительные пути к ассетам, чтобы фронт работал
// и на Vercel (корень), и на GitHub Pages (подпуть /<repo>/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
