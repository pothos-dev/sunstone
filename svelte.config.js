// Adapter is target-dependent:
//
//  - WEB build (`SUNSTONE_TARGET=web`): `@sveltejs/adapter-node` with SSR on
//    (see `+layout.ts`), so the read-only viewer is server-rendered then
//    hydrates and is served by a Node process behind the `/_api` proxy.
//  - DEFAULT (desktop/Tauri): `@sveltejs/adapter-static` in SPA mode
//    (fallback index.html, `ssr = false`) — unchanged. Tauri has no Node
//    server, so the frontend must be a static SPA.
//
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapterStatic from "@sveltejs/adapter-static";
import adapterNode from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const isWeb = process.env.SUNSTONE_TARGET === "web";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: isWeb
      ? adapterNode({ out: process.env.SUNSTONE_NODE_OUT || "build" })
      : adapterStatic({
          fallback: "index.html",
        }),
  },
};

export default config;
