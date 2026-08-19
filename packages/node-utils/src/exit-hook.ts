type Hook = () => void;

const hooks = new Set<Hook>();
let installed = false;
let running = false;

const runHooks = () => {
  if (running) return;
  running = true;
  for (const hook of hooks) hook();
  hooks.clear();
};

const onExit = () => runHooks();
const onSigint = () => {
  runHooks();
  process.exit(130);
};
const onSigterm = () => {
  runHooks();
  process.exit(143);
};

const install = () => {
  if (installed) return;
  installed = true;
  process.on("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
};

const uninstall = () => {
  if (!installed || hooks.size > 0) return;
  installed = false;
  running = false;
  process.off("exit", onExit);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
};

/** Register synchronous best-effort cleanup for abrupt process exit. */
export const exitHook = (hook: Hook): (() => void) => {
  hooks.add(hook);
  install();
  return () => {
    hooks.delete(hook);
    uninstall();
  };
};
