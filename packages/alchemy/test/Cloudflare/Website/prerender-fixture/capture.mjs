import server from "./dist/ssr/server.js";
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/capture.md") {
      if (env.TSS_PRERENDERING !== "true")
        throw new Error("Missing prerender variable");
      const asset = await env.ASSETS.fetch(
        new Request("http://assets/static.txt"),
      );
      if (!asset.ok) throw new Error("Missing preview assets");
      return new Response("# Build-only capture\n" + (await asset.text()));
    }
    return server.fetch(request, env, ctx);
  },
};
