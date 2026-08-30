/** @jsxImportSource react */
import {
  getLiveProgressWindow,
  PlanProgress,
} from "@/Cli/tui/components/PlanProgress.tsx";
import type { ApplyEvent } from "@/Cli/Event.ts";
import type { Plan } from "@/Plan.ts";
import { describe, expect, test } from "alchemy-test";
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";

describe("PlanProgress live window", () => {
  test("always stays below the terminal viewport", () => {
    for (const viewportRows of [1, 2, 10, 24, 80]) {
      const window = getLiveProgressWindow(viewportRows, 100);
      expect(window.height).toBeLessThan(Math.max(2, viewportRows));
      expect(window.visibleActiveCount + window.hiddenActiveCount).toBe(100);
    }
  });

  test("reserves the final line for an overflow indicator", () => {
    expect(getLiveProgressWindow(24, 100)).toEqual({
      height: 23,
      visibleActiveCount: 21,
      hiddenActiveCount: 79,
    });
  });

  test("shows every active row when it fits", () => {
    expect(getLiveProgressWindow(24, 3)).toEqual({
      height: 23,
      visibleActiveCount: 3,
      hiddenActiveCount: 0,
    });
  });

  test("keeps every completion without clearing scrollback", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `resource-${index}`);
    const plan = makePlan(ids);
    const listeners = new Set<(event: ApplyEvent) => void>();
    const stdout = new CaptureStream({ rows: 8 });
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (enabled: boolean) => void;
    };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};

    const app = render(
      <PlanProgress
        plan={plan}
        source={{
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await Bun.sleep(20);
      for (const id of ids) {
        emit(listeners, {
          kind: "status-change",
          id,
          type: "Test.Resource",
          status: "creating",
        });
      }
      await Bun.sleep(120);
      for (const id of ids) {
        emit(listeners, {
          kind: "status-change",
          id,
          type: "Test.Resource",
          status: "created",
        });
      }
      await Bun.sleep(120);
    } finally {
      app.unmount();
      stdin.destroy();
    }

    // Ink 6's fullscreen fallback uses erase-screen + erase-scrollback + home.
    expect(stdout.output).not.toContain("\u001B[2J\u001B[3J\u001B[H");
    for (const id of ids) {
      expect(stdout.output).toContain(id);
    }
  });
});

class CaptureStream extends Writable {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows: number;
  output = "";

  constructor(options: { rows: number }) {
    super();
    this.rows = options.rows;
  }

  _write(
    chunk: Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString();
    callback();
  }
}

const emit = (
  listeners: ReadonlySet<(event: ApplyEvent) => void>,
  event: ApplyEvent,
) => {
  for (const listener of listeners) listener(event);
};

const makePlan = (ids: string[]): Plan =>
  ({
    resources: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          action: "create",
          bindings: [],
          downstream: [],
          mode: undefined,
          props: {},
          provider: {},
          resource: {
            FQN: id,
            LogicalId: id,
            Namespace: undefined,
            Type: "Test.Resource",
          },
          state: undefined,
        },
      ]),
    ),
    deletions: {},
    actions: {},
    actionDeletions: {},
    defaultMode: "live",
  }) as unknown as Plan;
