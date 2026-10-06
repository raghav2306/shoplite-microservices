import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api is proxied to the gateway; in Docker, nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": process.env.API_GATEWAY_URL || "http://localhost:3000" },
  },
});
