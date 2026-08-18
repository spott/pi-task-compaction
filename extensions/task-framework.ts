import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigFlags, resolveConfig } from "../src/config.js";
import { registerTaskFramework } from "../src/task-framework.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import { loadWorkerBootstrap } from "../src/workers/bootstrap.js";

/**
 * Greenfield v2 extension entrypoint. Pi parses extension-defined CLI flags only
 * after factories load, so feature registration is deferred to session_start.
 */
export default function taskFrameworkExtension(pi: ExtensionAPI): void {
  registerConfigFlags(pi);
  const bootstrapPromise = loadWorkerBootstrap();
  let initialized = false;
  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;
    const bootstrap = await bootstrapPromise;
    const config = resolveConfig({ cwd: ctx.cwd, getFlag: (name) => pi.getFlag(name) });
    if (bootstrap && !config.features.agents) {
      throw new Error("Worker bootstrap requires features.agents=true");
    }
    const registry = bootstrap ? await FileRunRegistry.open(bootstrap.runDirectory) : undefined;
    const services = registerTaskFramework(pi, config, {
      registerSessionStart: false,
      ...(bootstrap && registry ? { worker: { bootstrap, registry } } : {}),
    });
    initialized = true;
    services?.ensureLoaded(ctx);
    await services?.startWorker(ctx);
  });
}
