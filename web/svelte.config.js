import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // SPA mode — index.html serves all routes; CloudFront handles 403/404 → /
      fallback: "index.html",
    }),
    alias: {
      $lib: "src/lib",
      $api: "src/lib/api",
    },
  },
};

export default config;
