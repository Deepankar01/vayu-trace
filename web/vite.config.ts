/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2500 }, // maplibre + deck.gl (+ extensions) are inherently large
  server: {
    port: 5173,
    strictPort: true,
    // `make dev API_PORT=...` sets VAYU_API_PORT so the proxy follows the API
    proxy: { "/api": `http://localhost:${process.env.VAYU_API_PORT ?? "8000"}` },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
