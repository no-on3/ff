import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The admin dashboard's address is part of its login (the realm's ff-admin
// client) and of the API's CORS_ORIGIN, so it never moves: 5198, next to the
// console's 5199. In production it has its own hostname (D12).
const ADMIN_PORT = 5198

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: ADMIN_PORT, strictPort: true },
  preview: { port: ADMIN_PORT, strictPort: true },
})
