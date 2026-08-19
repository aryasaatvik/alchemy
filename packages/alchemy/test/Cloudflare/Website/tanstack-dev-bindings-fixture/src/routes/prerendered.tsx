/** @jsxImportSource react */
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getRuntime = createServerFn({ method: "GET" }).handler(async () => {
  const { env, tracing } = await import("cloudflare:workers");
  return tracing.enterSpan("alchemy.prerender.fixture", (span) => {
    span.setAttribute("fixture", "tanstack-start");
    return typeof env;
  });
});

export const Route = createFileRoute("/prerendered")({
  loader: () => getRuntime(),
  component: Prerendered,
});

function Prerendered() {
  return <main>{`workerd prerender: ${Route.useLoaderData()}`}</main>;
}
