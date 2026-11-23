/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server binds to loopback only and proxies /api to the local backend.
const backend = process.env.SKH_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: backend, changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  // Never inline assets as data: URIs — the production CSP allows only same-origin fonts.
  build: { sourcemap: false, target: "es2022", assetsInlineLimit: 0 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
