import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { parseListenOptions } from "../server/cli.js";
const options = {
  groups: [],
  telemetryPath: "/nonexistent-dashboard-test.sqlite",
};
test("host and port accept generic CLI values with environment fallback", () => {
  assert.deepEqual(parseListenOptions([], {}), {
    host: "127.0.0.1",
    port: 3210,
    help: false,
  });
  assert.deepEqual(
    parseListenOptions(["--host", "192.168.1.5", "--port", "8080"], {
      DASHBOARD_HOST: "localhost",
      DASHBOARD_PORT: "9999",
    }),
    { host: "192.168.1.5", port: 8080, help: false },
  );
  for (const host of [
    "0.0.0.0",
    "::",
    "::1",
    "192.168.1.5",
    "100.64.0.1",
    "dashboard.internal",
  ])
    assert.equal(parseListenOptions(["--host", host], {}).host, host);
  assert.equal(
    parseListenOptions(["--host", "--port", "8080"], {}).host,
    "0.0.0.0",
  );
  assert.equal(parseListenOptions(["--host"], {}).host, "0.0.0.0");
  assert.equal(
    parseListenOptions([], {
      DASHBOARD_HOST: "10.0.0.1",
      DASHBOARD_PORT: "8080",
    }).port,
    8080,
  );
  assert.equal(parseListenOptions(["--help"], {}).help, true);
  for (const port of ["0", "65536", "1.5", "abc"])
    assert.throws(() => parseListenOptions(["--port", port], {}));
  for (const host of ["", "http://localhost", "localhost/path", "bad host"])
    assert.throws(() => parseListenOptions(["--host", host], {}));
  assert.throws(() => parseListenOptions(["--unknown"], {}));
});
test("configured hostname works while mutations and foreign origins remain forbidden", async () => {
  const app = buildApp({ ...options, listenHost: "dashboard.internal" });
  try {
    assert.equal(
      (
        await app.inject({
          url: "/api/meta",
          headers: {
            host: "dashboard.internal:8080",
            origin: "http://dashboard.internal:8080",
          },
        })
      ).statusCode,
      200,
    );
    for (const headers of [
      { host: "evil.example" },
      { host: "dashboard.internal:8080", origin: "http://evil.example" },
      {
        host: "dashboard.internal:8080",
        origin: "http://dashboard.internal:9999",
      },
      { host: "dashboard.internal:8080", "sec-fetch-site": "cross-site" },
      { host: "evil.example", "x-forwarded-host": "dashboard.internal" },
    ])
      assert.equal(
        (await app.inject({ url: "/api/meta", headers })).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/meta",
          headers: { host: "dashboard.internal:8080" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("wildcard binding permits IP hosts without accepting arbitrary DNS hostnames", async () => {
  const app = buildApp({ ...options, listenHost: "0.0.0.0" }),
    local = buildApp(options);
  try {
    for (const host of [
      "192.168.1.5:3210",
      "100.64.0.1:3210",
      "[2001:db8::1]:3210",
    ])
      assert.equal(
        (await app.inject({ url: "/api/meta", headers: { host } })).statusCode,
        200,
      );
    assert.equal(
      (
        await app.inject({
          url: "/api/meta",
          headers: { host: "evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await local.inject({
          url: "/api/meta",
          headers: { host: "192.168.1.5:3210" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await local.close();
  }
});
