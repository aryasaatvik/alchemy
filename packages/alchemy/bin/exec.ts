import { exec } from "alchemy/Cli";
import { runMain } from "alchemy/Util/PlatformServices";
import { defaultTeardown } from "effect/Runtime";

// The watched evaluator has a different successful-completion contract from
// deploy/destroy. Alchemy's default runMain teardown force-exits successful
// commands to release provider keep-alive sockets, but doing that here also
// terminates Bun's `--watch` process. Preserve the platform runtime's native
// successful teardown so the watcher remains the lifetime authority across
// imported-file re-evaluations. Signal interruption and failures still exit
// with their non-zero runtime codes.
runMain(exec(), { teardown: defaultTeardown });
