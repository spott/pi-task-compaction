import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigFlags, resolveConfig } from "../src/config.js";
import { registerTaskFramework } from "../src/task-framework.js";

/**
 * Greenfield v2 extension entrypoint. Pi parses extension-defined CLI flags only
 * after factories load, so feature registration is deferred to session_start.
 */
export default function taskFrameworkExtension(pi: ExtensionAPI): void {
  registerConfigFlags(pi);
  let initialized = false;
  pi.on("session_start", (_event, ctx) => {
    if (initialized) return;
    const config = resolveConfig({ cwd: ctx.cwd, getFlag: (name) => pi.getFlag(name) });
    const services = registerTaskFramework(pi, config, { registerSessionStart: false });
    initialized = true;
    services?.ensureLoaded(ctx);
  });
}
