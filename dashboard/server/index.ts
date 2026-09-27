import { resolve } from "node:path";
import { loadAppConfig } from "../../src/config-loader.js";
import { dashboardGroupSources } from "./sources.js";
import { buildApp } from "./app.js";
import { parseListenOptions } from "./cli.js";
const { host, port, help } = parseListenOptions(process.argv.slice(2));
if (help) {
  console.log(
    "Usage: npm run dashboard:start -- [--host [address]] [--port number]\nDefaults: 127.0.0.1:3210. Bare --host binds all IPv4 interfaces.\nEnvironment: DASHBOARD_HOST, DASHBOARD_PORT (CLI takes precedence).",
  );
  process.exit(0);
}
const config = loadAppConfig();
const app = buildApp({
  // Historical read authorization is separate from live bot membership/routing.
  getGroups: () => dashboardGroupSources(config),
  telemetryPath: config.storage.telemetryPath,
  webRoot: resolve("dist-dashboard/web"),
  listenHost: host,
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
try {
  const address = await app.listen({ host, port });
  console.log(`Dashboard listening at ${address} (read-only)`);
} catch {
  console.error("Dashboard startup failed");
  await stop();
  process.exitCode = 1;
}
