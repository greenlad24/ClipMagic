import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * The page code was lifted out of a larger app that imported its backend as a
 * bare `zite-endpoints-sdk` specifier. That specifier is kept — and mapped to
 * the local shim — so `AvatarNarratorPage.tsx` and the three avatar components
 * run here byte-identical to the original. `@` resolves to this app's src.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "zite-endpoints-sdk": path.resolve(__dirname, "src/shims/endpoints.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // `npm run dev` serves the UI here and the API on 8080; proxy so the app
    // still talks to a single origin and the shim's relative fetches work.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
