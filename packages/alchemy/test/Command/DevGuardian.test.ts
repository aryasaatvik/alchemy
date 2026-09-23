import { guardDevProcessGroup } from "@/Command/DevGuardian.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { assert, describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { assertDead, pidAlive } from "./fixture/lifecycle-support.ts";

/** A detached process group that idles until killed. */
const idleGroup = ChildProcess.make(
  process.execPath,
  ["-e", "setInterval(() => {}, 60000)"],
  {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    killSignal: "SIGKILL",
  },
);

describe.skipIf(process.platform === "win32")(
  "Command.Dev process-group guardian",
  { tags: ["unit", "local"] },
  () => {
    it.live("retires with its scope and leaves the group running", () =>
      Effect.gen(function* () {
        const target = yield* idleGroup;
        const scope = yield* Scope.make();
        const guardian = yield* guardDevProcessGroup(target.pid).pipe(
          Scope.provide(scope),
        );
        assert(guardian !== undefined);
        expect(yield* pidAlive(guardian.pid)).toBe(true);

        yield* Scope.close(scope, Exit.void);
        yield* assertDead(guardian.pid);
        expect(yield* pidAlive(target.pid)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    );

    it.live("exits once the guarded group is gone", () =>
      Effect.gen(function* () {
        const target = yield* idleGroup;
        const guardian = yield* guardDevProcessGroup(target.pid);
        assert(guardian !== undefined);
        yield* Effect.sync(() => process.kill(-target.pid, "SIGKILL"));
        yield* assertDead(target.pid);
        yield* assertDead(guardian.pid);
      }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
    );
  },
);
