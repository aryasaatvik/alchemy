import {
  hasActiveVitePluginOptions,
  vitePlugin,
} from "alchemy/Cloudflare/VitePlugin";
import { preview } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";

export default {
  // Frameworks build client + SSR themselves, then run post-build prerender hooks.
  builder: {
    async buildApp(builder) {
      for (const name of ["client", "ssr"])
        await builder.build(builder.environments[name]);
    },
  },
  plugins: [
    ...(process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
      ? []
      : [vitePlugin()]),
    {
      name: "fixture:prerender",
      enforce: "post",
      buildApp: {
        order: "post",
        async handler(builder) {
          if (!hasActiveVitePluginOptions())
            throw new Error("Missing nested build options");
          process.env.TSS_PRERENDERING = "true";
          const server = await preview({
            root: builder.config.root,
            preview: { host: "127.0.0.1", port: 0 },
          });
          try {
            const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
            const response = await fetch(`${origin}/capture.md`);
            if (!response.ok)
              throw new Error(`Prerender returned ${response.status}`);
            const fallback = await fetch(`${origin}/ordinary`);
            if ((await fallback.text()) !== "deployed worker")
              throw new Error("Compiled SSR fallback failed");
            await fs.writeFile(
              path.join(builder.config.root, "dist/client/capture.md"),
              await response.text(),
            );
          } finally {
            await server.close();
            delete process.env.TSS_PRERENDERING;
          }
        },
      },
    },
  ],
};
