import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * The original ClipMagic frontend (under ../src) was built on Zite and imports
 * three Zite SDKs by bare specifier. We map those specifiers to local shim
 * modules (web/src/shims/*) that talk to the self-hosted server instead, so the
 * original app code runs unchanged. `@` resolves to the original ../src tree.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src"),
      "zite-endpoints-sdk": path.resolve(__dirname, "src/shims/endpoints.ts"),
      "zite-auth-sdk": path.resolve(__dirname, "src/shims/auth.tsx"),
      "zite-file-upload-sdk": path.resolve(__dirname, "src/shims/fileUpload.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { port: 5173 },
});
