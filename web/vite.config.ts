import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    sveltekit(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        id: "/mail",
        name: "Dork Mail",
        short_name: "Dork Mail",
        description: "Self-hosted personal email",
        theme_color: "#4f5ec7",
        background_color: "#0f1117",
        display: "standalone",
        start_url: "/mail",
        scope: "/",
        categories: ["productivity", "utilities"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Compose", url: "/mail/compose", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        // SPA shell for offline launches; API calls always go to the network.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,webmanifest}"],
        importScripts: ["/push-sw.js"],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
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
