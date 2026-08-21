import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigFlags, resolveConfig } from "../src/config.js";
import { registerTaskFramework } from "../src/task-framework.js";
import { FileRunRegistry, openOrCreateRunRegistry } from "../src/store/run-registry.js";
import { loadWorkerBootstrap } from "../src/workers/bootstrap.js";

/**
 * Greenfield v2 extension entrypoint. Pi parses extension-defined CLI flags only
 * after factories load, so feature registration is deferred to session_start.
 */
export default function taskFrameworkExtension(pi: ExtensionAPI): void {
  registerConfigFlags(pi);
  const bootstrapPromise = loadWorkerBootstrap();
  let initialized = false;
  let services: ReturnType<typeof registerTaskFramework>;
  pi.on("session_start", async (_event, ctx) => {
    if (!initialized) {
      const bootstrap = await bootstrapPromise;
      const config = resolveConfig({ cwd: ctx.cwd, getFlag: (name) => pi.getFlag(name) });
      if (bootstrap && !config.features.agents) {
        throw new Error("Worker bootstrap requires features.agents=true");
      }
      const registry = config.features.agents
        ? bootstrap
          ? await FileRunRegistry.open(bootstrap.runDirectory)
          : await openOrCreateRunRegistry(pi, ctx.sessionManager)
        : undefined;
      if (bootstrap && registry?.runId !== bootstrap.runId) {
        throw new Error(`Worker bootstrap run ${bootstrap.runId} does not match registry ${registry?.runId}`);
      }
      services = registerTaskFramework(pi, config, {
        registerSessionStart: false,
        ...(registry
          ? {
              agents: {
                registry,
                localSessionId: ctx.sessionManager.getSessionId(),
                ...(bootstrap ? { bootstrap } : {}),
                ...(!bootstrap
                  ? {
                      openRegistry: async (destination: typeof ctx) =>
                        openOrCreateRunRegistry(pi, destination.sessionManager),
                    }
                  : {}),
              },
            }
          : {}),
      });
      initialized = true;
    }
    await services?.startSession(ctx);
  });
}
