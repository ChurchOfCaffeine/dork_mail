import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      // SPA mode. The root index.html belongs to Bulwark; CloudFront routes /admin/* to this fallback.
      adapter: adapter({ fallback: "admin/index.html" }),
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
