import * as Effect from "effect/Effect";
import { PlatformServices } from "../Util/PlatformServices.ts";
import * as Bundle from "./Bundle.ts";
import type { IsolatedBuildRequest, IsolatedBuildResponse } from "./IsolatedBuild.ts";

process.once("message", async (request: IsolatedBuildRequest) => {
  let response: IsolatedBuildResponse;
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const virtualEntry = yield* Bundle.virtualEntryPlugin;
        return yield* Bundle.build(
          {
            ...request.inputOptions,
            plugins: request.entries.map((sources) =>
              virtualEntry((entry) => {
                const source = sources[entry];
                if (source === undefined) throw new Error(`Missing immutable entry: ${entry}`);
                return source;
              }),
            ),
          },
          request.outputOptions,
          request.extra,
        );
      }).pipe(Effect.provide(PlatformServices)),
    );
    response = { _tag: "Success", output };
  } catch (error) {
    response = { _tag: "Error", message: error instanceof Error ? error.message : String(error) };
  }
  // Rolldown's native allocator can retain the closed graph; process exit is
  // the lifetime boundary, including plugins that leave event-loop handles.
  if (process.send === undefined)
    throw new Error("Immutable bundle compiler requires an IPC channel");
  process.send(response, () => process.exit(response._tag === "Success" ? 0 : 1));
});
