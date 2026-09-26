import { isIP } from "node:net";
import { parseArgs } from "node:util";

export function parseListenOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalized = args.flatMap((arg, index) =>
    arg === "--host" &&
    (args[index + 1] === undefined || args[index + 1]!.startsWith("--"))
      ? ["--host=0.0.0.0"]
      : [arg],
  );
  const { values } = parseArgs({
    args: normalized,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const host = values.host ?? env.DASHBOARD_HOST ?? "127.0.0.1";
  const port = values.port ?? env.DASHBOARD_PORT ?? "3210";
  if (
    !host ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
  )
    throw new Error("Invalid dashboard host");
  if (
    !/^\d+$/.test(port) ||
    !Number.isSafeInteger(Number(port)) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error("Invalid dashboard port");
  return { host, port: Number(port), help: values.help === true };
}
