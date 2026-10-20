import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The console's address is part of its login (the realm's redirect URIs) and
// of the API's CORS_ORIGIN, so it never moves to another port: 5199, not
// Vite's 5173, which other projects' dev servers often hold.
const CONSOLE_PORT = 5199

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: CONSOLE_PORT, strictPort: true },
  preview: { port: CONSOLE_PORT, strictPort: true },
})
