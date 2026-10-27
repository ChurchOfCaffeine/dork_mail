import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      // SPA mode — index.html serves all routes; CloudFront handles 403/404 → /
      adapter: adapter({ fallback: "index.html" }),
    }),
  ],
  server: {
    proxy: {
      // Proxy /api to the API Gateway during local dev
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
