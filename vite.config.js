import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ensures every .wasm file is served with the correct MIME type
// (required by WebAssembly.instantiateStreaming used by the Rust crypto module).
const wasmMime = () => ({
  name: "wasm-mime",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.split("?")[0].endsWith(".wasm")) {
        res.setHeader("Content-Type", "application/wasm");
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.split("?")[0].endsWith(".wasm")) {
        res.setHeader("Content-Type", "application/wasm");
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), wasmMime()],
  // The crypto-wasm package locates its .wasm via new URL(..., import.meta.url);
  // pre-bundling would break that path, so exclude it from optimizeDeps.
  optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm"] },
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  server: { port: 5173, strictPort: false, open: true },
});
