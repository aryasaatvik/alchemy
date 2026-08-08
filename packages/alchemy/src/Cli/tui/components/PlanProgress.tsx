/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import { Box, Static, Text, useStdout } from "ink";
import type { CRUD, Plan, ActionApply, ActionDelete } from "../../../Plan.ts";

import type {
  ApplyEvent,
  ApplyStatus,
  StatusChangeEvent,
} from "../../Event.ts";
import {
  buildNamespaceTree,
  flattenTree,
  type FlattenedItem,
  type ActionVerb,
} from "../../NamespaceTree.ts";
import { formatModeNote } from "../../ModeTag.ts";
import type { ProviderMode } from "../../../ProviderMode.ts";

interface ProgressEventSource {
  subscribe(listener: (event: ApplyEvent) => void): () => void;
}

interface PlanTask extends Required<
  Pick<StatusChangeEvent, "id" | "type" | "status">
> {
  key: string;
  message?: string;
  updatedAt: number;
}

interface PlanProgressProps {
  source: ProgressEventSource;
  plan: Plan;
}

interface CompletedTask {
  key: string;
  row: WorkProgressRow;
  task: PlanTask;
}

interface ProgressState {
  tasks: Map<string, PlanTask>;
  completed: CompletedTask[];
  completedKeys: Set<string>;
}

type PlanItem = CRUD | NonNullable<Plan["deletions"][string]>;

export type ProgressRow =
  | {
      key: string;
      type: "namespace";
      id: string;
      depth: number;
      action: FlattenedItem["action"];
    }
  | {
      key: string;
      type: "resource";
      id: string;
      depth: number;
      resourceType: string;
      action: CRUD["action"];
      /** For `noop` resources, persisted state status to show instead of `pending`. */
      persistedApplyStatus?: "created" | "updated";
      /** Resolved provider mode; `undefined` for mode-agnostic providers. */
      providerMode?: ProviderMode;
      /** On mode-switch replacements, the old generation's stamped mode. */
      fromProviderMode?: ProviderMode;
    }
  | {
      key: string;
      type: "task";
      id: string;
      depth: number;
      actionType: string;
      action: ActionVerb;
    };

const getTaskKey = (item: FlattenedItem) => item.path.join("/");

type ResourceProgressRow = Extract<ProgressRow, { type: "resource" }>;
type WorkProgressRow = Extract<ProgressRow, { type: "resource" | "task" }>;

export const buildProgressRows = (plan: Plan): ProgressRow[] => {
  const items = [
    ...Object.values(plan.resources),
    ...Object.values(plan.deletions).filter(
      (item): item is NonNullable<Plan["deletions"][string]> =>
        item !== undefined,
    ),
  ] as PlanItem[];
  const taskItems = [
    ...Object.values(plan.actions ?? {}),
    ...Object.values(plan.actionDeletions ?? {}),
  ].filter((t): t is ActionApply | ActionDelete => t !== undefined);
  const tree = buildNamespaceTree(items, taskItems);
  return flattenTree(tree)
    .filter((item) => item.type !== "binding")
    .map((item) => {
      if (item.type === "namespace") {
        return {
          key: getTaskKey(item),
          type: "namespace" as const,
          id: item.id,
          depth: item.depth,
          action: item.action,
        };
      }
      if (item.type === "action") {
        return {
          key: getTaskKey(item),
          type: "task" as const,
          id: item.id,
          depth: item.depth,
          actionType: item.actionType ?? "unknown",
          action: item.action as ActionVerb,
        };
      }
      return {
        key: getTaskKey(item),
        type: "resource" as const,
        id: item.id,
        depth: item.depth,
        resourceType: item.resourceType ?? "unknown",
        action: item.action as CRUD["action"],
        providerMode: item.providerMode,
        fromProviderMode: item.fromProviderMode,
        persistedApplyStatus:
          item.action === "noop"
            ? (() => {
                const crud = findCrudByLogicalId(plan, item.id);
                return crud?.action === "noop" ? crud.state.status : undefined;
              })()
            : undefined,
      };
    });
};

const buildLogicalIdIndex = (rows: ProgressRow[]) => {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    if (row.type !== "resource" && row.type !== "task") continue;
    const keys = index.get(row.id);
    if (keys) {
      keys.push(row.key);
    } else {
      index.set(row.id, [row.key]);
    }
  }
  return index;
};

export function toPlanTask(id: string, planItem: PlanItem): PlanTask;
export function toPlanTask(row: ResourceProgressRow): PlanTask;
export function toPlanTask(
  rowOrId: ResourceProgressRow | string,
  planItem?: PlanItem,
): PlanTask {
  if (typeof rowOrId === "string") {
    return {
      key: rowOrId,
      id: rowOrId,
      type: planItem!.resource.Type,
      status: planItem!.action === "noop" ? planItem!.state.status : "pending",
      updatedAt: Date.now(),
    };
  }

  return {
    key: rowOrId.key,
    id: rowOrId.id,
    type: rowOrId.resourceType,
    status:
      rowOrId.action === "noop"
        ? (rowOrId.persistedApplyStatus ?? "created")
        : "pending",
    updatedAt: Date.now(),
  };
}

const buildInitialTasks = (rows: ProgressRow[]) =>
  new Map(
    rows.flatMap((row) =>
      row.type === "resource"
        ? [[row.key, toPlanTask(row)]]
        : row.type === "task"
          ? [
              [
                row.key,
                {
                  key: row.key,
                  id: row.id,
                  type: row.actionType,
                  // `noop` tasks are skipped — render as gray `•` from the start
                  // rather than briefly flashing the `ran` cyan styling.
                  status:
                    row.action === "noop"
                      ? ("skipped" as ApplyStatus)
                      : ("pending" as ApplyStatus),
                  updatedAt: Date.now(),
                },
              ],
            ]
          : [],
    ),
  );

const buildInitialState = (rows: ProgressRow[]): ProgressState => ({
  tasks: buildInitialTasks(rows),
  completed: [],
  completedKeys: new Set(),
});

export function PlanProgress(props: PlanProgressProps): JSX.Element {
  const { source, plan } = props;
  const spinner = useGlobalSpinner();
  const viewportRows = useViewportRows();
  const rows = useMemo(() => buildProgressRows(plan), [plan]);
  const logicalIdIndex = useMemo(() => buildLogicalIdIndex(rows), [rows]);
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const [progress, setProgress] = useState<ProgressState>(() =>
    buildInitialState(rows),
  );

  const unsubscribeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = source.subscribe((event) => {
      setProgress((prev) => {
        const tasks = new Map(prev.tasks);
        const completed = [...prev.completed];
        const completedKeys = new Set(prev.completedKeys);
        const keys = logicalIdIndex.get(event.id) ?? [];

        if (event.kind === "status-change") {
          if (!event.bindingId) {
            for (const key of keys) {
              const current = tasks.get(key);
              const task = {
                key,
                id: event.id,
                type: event.type,
                status: event.status,
                message: event.message ?? current?.message,
                updatedAt: Date.now(),
              } satisfies PlanTask;
              tasks.set(key, task);

              const row = rowsByKey.get(key);
              if (
                isTerminal(event.status) &&
                row !== undefined &&
                row.type !== "namespace" &&
                row.action !== "noop" &&
                !completedKeys.has(key)
              ) {
                completedKeys.add(key);
                completed.push({ key, row, task });
              }
            }
          }
        } else {
          for (const key of keys) {
            const current = tasks.get(key);
            if (!current) continue;
            tasks.set(key, {
              ...current,
              message: event.message,
              updatedAt: Date.now(),
            });
          }
        }

        return { tasks, completed, completedKeys };
      });
    });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [logicalIdIndex, rowsByKey, source]);

  useEffect(() => {
    setProgress(buildInitialState(rows));
  }, [rows]);

  const workRows = rows.filter(
    (row): row is WorkProgressRow =>
      row.type !== "namespace" && row.action !== "noop",
  );
  const activeRows = workRows
    .filter((row) => {
      const status = progress.tasks.get(row.key)?.status ?? "pending";
      return status !== "pending" && !isTerminal(status);
    })
    .sort(
      (a, b) =>
        (progress.tasks.get(b.key)?.updatedAt ?? 0) -
        (progress.tasks.get(a.key)?.updatedAt ?? 0),
    );
  const pendingCount = workRows.filter(
    (row) => (progress.tasks.get(row.key)?.status ?? "pending") === "pending",
  ).length;
  const failedCount = progress.completed.filter(
    ({ task }) => task.status === "fail",
  ).length;
  const completedCount = progress.completed.length;
  const liveWindow = getLiveProgressWindow(viewportRows, activeRows.length);
  const visibleActiveRows = activeRows.slice(0, liveWindow.visibleActiveCount);

  return (
    <Box flexDirection="column">
      <Static items={progress.completed}>
        {({ key, row, task }) => (
          <ProgressItem
            key={key}
            row={row}
            task={task}
            spinner={spinner}
            defaultMode={plan.defaultMode}
          />
        )}
      </Static>
      <Box flexDirection="column" height={liveWindow.height} overflowY="hidden">
        <ProgressSummary
          activeCount={activeRows.length}
          completedCount={completedCount}
          failedCount={failedCount}
          pendingCount={pendingCount}
          spinner={spinner}
          totalCount={workRows.length}
        />
        {visibleActiveRows.map((row) => (
          <ProgressItem
            key={row.key}
            row={row}
            task={progress.tasks.get(row.key) ?? toInitialTask(row)}
            spinner={spinner}
            defaultMode={plan.defaultMode}
            truncate
          />
        ))}
        {liveWindow.hiddenActiveCount > 0 ? (
          <Text dimColor>… {liveWindow.hiddenActiveCount} more active</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function ProgressSummary(props: {
  activeCount: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  spinner: string;
  totalCount: number;
}): JSX.Element {
  const done = props.completedCount >= props.totalCount;
  const icon = done ? (props.failedCount > 0 ? "✗" : "✓") : props.spinner;
  return (
    <Text color={props.failedCount > 0 ? "redBright" : undefined}>
      {icon} Apply {props.completedCount}/{props.totalCount}
      {props.activeCount > 0 ? ` · ${props.activeCount} active` : ""}
      {props.pendingCount > 0 ? ` · ${props.pendingCount} pending` : ""}
      {props.failedCount > 0 ? ` · ${props.failedCount} failed` : ""}
    </Text>
  );
}

function ProgressItem(props: {
  row: WorkProgressRow;
  task: PlanTask;
  spinner: string;
  defaultMode?: ProviderMode;
  truncate?: boolean;
}): JSX.Element {
  const { row, task, spinner } = props;
  const indent = "  ".repeat(row.depth);
  const modeNote =
    row.type === "resource"
      ? formatModeNote({
          mode: row.providerMode,
          priorMode: row.fromProviderMode,
          defaultMode: props.defaultMode,
        })
      : undefined;
  const status =
    row.type === "resource" ? getDisplayStatus(row, task.status) : task.status;
  const color = statusColor(status);
  const icon =
    row.type === "task"
      ? taskIcon(row.action, task.status, spinner)
      : statusIcon(task.status, spinner);
  const metadata = [
    `(${task.type})`,
    modeNote ? `(${modeNote})` : undefined,
    row.type === "task" ? "[action]" : undefined,
    task.message ? `— ${task.message}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return (
    <Box flexDirection="row" height={props.truncate ? 1 : undefined}>
      <Text>{indent}</Text>
      <Box width={2}>
        <Text color={color}>{icon} </Text>
      </Box>
      <Text bold>{task.id}</Text>
      <Text color={color}> {status}</Text>
      {metadata ? (
        <Text dimColor wrap={props.truncate ? "truncate-end" : "wrap"}>
          {" "}
          {metadata}
        </Text>
      ) : null}
    </Box>
  );
}

const toInitialTask = (row: WorkProgressRow): PlanTask =>
  row.type === "resource"
    ? toPlanTask(row)
    : {
        key: row.key,
        id: row.id,
        type: row.actionType,
        status: row.action === "noop" ? "skipped" : "pending",
        updatedAt: Date.now(),
      };

export const getLiveProgressWindow = (
  viewportRows: number,
  activeCount: number,
): {
  height: number;
  visibleActiveCount: number;
  hiddenActiveCount: number;
} => {
  // Ink 6 clears the terminal, including scrollback, when a rerendered frame
  // reaches the viewport height. Keep the animated frame strictly shorter;
  // completed rows leave this window through <Static> above.
  const height = Math.max(1, viewportRows - 1);
  const activeCapacity = Math.max(0, height - 1);
  const visibleActiveCount =
    activeCount > activeCapacity
      ? Math.max(0, activeCapacity - 1)
      : activeCount;
  return {
    height,
    visibleActiveCount,
    hiddenActiveCount: activeCount - visibleActiveCount,
  };
};

function useViewportRows(): number {
  const { stdout } = useStdout();
  const readRows = () => stdout.rows ?? 24;
  const [rows, setRows] = useState(readRows);

  useEffect(() => {
    const onResize = () => setRows(readRows());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return rows;
}

function getDisplayStatus(
  row: ResourceProgressRow,
  status: ApplyStatus,
): ApplyStatus | "no change" {
  if (row.action === "noop" && (status === "created" || status === "updated")) {
    return "no change";
  }

  return status;
}

function statusColor(
  status: ApplyStatus | "no change",
): Parameters<typeof Text>[0]["color"] {
  switch (status) {
    case "no change":
      return "gray";
    case "pending":
      return "gray";
    case "creating":
    case "created":
      return "green";
    case "updating":
    case "updated":
      return "yellow";
    case "deleting":
    case "deleted":
      return "red";
    case "retained":
      return "gray";
    case "running":
    case "ran":
      return "cyan";
    case "skipped":
      return "gray";
    case "fail":
      return "redBright";
    default:
      return undefined;
  }
}

function taskIcon(
  action: ActionVerb,
  status: ApplyStatus,
  spinnerChar: string,
): string {
  if (status === "running") return spinnerChar;
  if (status === "fail") return "✗";
  if (status === "skipped") return "•";
  if (status === "ran") return action === "noop" ? "•" : "✓";
  if (status === "deleted" || status === "retained") return "✓";
  if (action === "delete") return "-";
  if (action === "noop") return "•";
  return "λ";
}

function statusIcon(status: ApplyStatus, spinnerChar: string): string {
  if (isInProgress(status)) return spinnerChar;
  if (status === "fail") return "✗";
  return "✓"; // created/updated/deleted/replaced/etc.
}

function isInProgress(status: ApplyStatus): boolean {
  return (
    status === "attaching" ||
    status === "post-attach" ||
    status === "pending" ||
    status === "pre-creating" ||
    status === "creating" ||
    status === "creating replacement" ||
    status === "updating" ||
    status === "deleting" ||
    status === "replacing" ||
    status === "running"
  );
}

function isTerminal(status: ApplyStatus): boolean {
  return (
    status === "created" ||
    status === "updated" ||
    status === "deleted" ||
    status === "retained" ||
    status === "replaced" ||
    status === "ran" ||
    status === "skipped" ||
    status === "fail"
  );
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useGlobalSpinner(intervalMs = 80): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % spinnerFrames.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return spinnerFrames[index];
}

const findCrudByLogicalId = (
  plan: Plan,
  logicalId: string,
): CRUD | undefined => {
  for (const node of Object.values(plan.resources)) {
    if (node.resource.LogicalId === logicalId) {
      return node;
    }
  }
  for (const node of Object.values(plan.deletions)) {
    if (node?.resource.LogicalId === logicalId) {
      return node;
    }
  }
  return undefined;
};
