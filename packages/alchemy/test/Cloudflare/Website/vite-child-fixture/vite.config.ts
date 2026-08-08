import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "report-process-cwd",
      configureServer(server) {
        server.middlewares.use("/__vite-child-origin", (_request, response) => {
          const address = server.httpServer?.address();
          if (
            address === null ||
            address === undefined ||
            typeof address === "string"
          ) {
            response.statusCode = 500;
            response.end(JSON.stringify({ address }));
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              host: address.address,
              port: address.port,
              cwd: process.cwd(),
            }),
          );
        });
      },
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `<meta name="vite-process-cwd" content="${process.cwd()}"></head>`,
        );
      },
    },
  ],
});
