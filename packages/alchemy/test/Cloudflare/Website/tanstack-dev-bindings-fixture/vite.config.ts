import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { vitePlugin as alchemyCloudflare } from "alchemy/Cloudflare/VitePlugin";
import { defineConfig } from "vite";

const alchemyOwnsCloudflarePlugin =
  process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1";

export default defineConfig({
  plugins: [
    ...(alchemyOwnsCloudflarePlugin ? [] : [alchemyCloudflare()]),
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: [{ path: "/prerendered" }],
    }),
    viteReact(),
  ],
});
