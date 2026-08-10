import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4310,
    strictPort: true,
    watch: {
      ignored: ["**/.larger/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:4311",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4310,
    strictPort: true,
  },
});
