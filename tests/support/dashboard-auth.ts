import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type AppOptions } from "../../src/dashboard/server/app.js";
import { AuthStore, SESSION_COOKIE } from "../../src/dashboard/server/auth.js";

/** Test-only real credentials: all requests still traverse production auth hooks. */
export function buildAuthenticatedApp(options: AppOptions) {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-auth-fixture-"));
  const auth = new AuthStore({ path: join(dir, "auth.sqlite"), password: "test-password-long" });
  try {
    const app = buildApp({ ...options, auth });
    app.addHook("onClose", async () => {
      auth.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const result = auth.login("test-password-long", "127.0.0.1");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("Fixture login failed");
    const cookie = `${SESSION_COOKIE}=${result.token}`;
    const inject = app.inject.bind(app);
    app.inject = ((value: any) => inject(typeof value === "string"
      ? { url: value, headers: { cookie } }
      : { ...value, headers: { cookie, ...value.headers } })) as typeof app.inject;
    return app;
  } catch (error) {
    auth.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
