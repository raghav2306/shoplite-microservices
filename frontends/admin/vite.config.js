import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The admin app lives under /admin/ so it can share one load balancer with the
// storefront (which owns /). API calls go to /api, proxied to the gateway in dev.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": process.env.API_GATEWAY_URL || "http://localhost:3000" },
  },
});
