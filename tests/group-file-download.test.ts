import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import {
  createGroupTextDownloader,
  downloadGroupText,
  type GroupTextDownloadDependencies,
} from "../src/group-file-download.js";

const REMOTE =
  "https://files.qq.example/ftn_handler/PRIVATE_PATH?token=PRIVATE_TOKEN";
const ERROR = /^Error: Group text download failed$/;
interface Settings {
  status?: number;
  headers?: IncomingMessage["headers"];
  chunks?: Buffer[];
  hang?: "headers" | "body";
  requestError?: boolean;
  responseError?: boolean;
  prematureClose?: boolean;
  incomplete?: boolean;
  synchronousHeaders?: boolean;
}
function fakeNetwork(body = Buffer.from("hello"), settings: Settings = {}) {
  let options: RequestOptions | undefined,
    requests = 0,
    dnsCalls = 0,
    destroyed = false;
  let response: IncomingMessage | undefined, respond: (() => void) | undefined;
  const request: NonNullable<GroupTextDownloadDependencies["request"]> = (
    opts,
    callback,
  ) => {
    options = opts;
    requests++;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => {
      destroyed = true;
      return req;
    }) as ClientRequest["destroy"];
    respond = () => {
      const stream = new PassThrough() as unknown as IncomingMessage;
      response = stream;
      stream.statusCode = settings.status ?? 200;
      stream.headers = settings.headers ?? {};
      stream.complete = !settings.incomplete;
      callback(stream);
      if (stream.destroyed) return;
      if (settings.responseError) {
        stream.emit("error", new Error("PRIVATE_TOKEN PRIVATE_PATH"));
        return;
      }
      if (settings.prematureClose) {
        stream.destroy();
        return;
      }
      for (const chunk of settings.chunks ?? [body]) stream.push(chunk);
      if (settings.hang !== "body") stream.push(null);
    };
    if (settings.synchronousHeaders) respond();
    req.end = (() => {
      if (settings.requestError)
        queueMicrotask(() =>
          req.emit("error", new Error("PRIVATE_TOKEN PRIVATE_PATH")),
        );
      else if (settings.hang !== "headers" && !settings.synchronousHeaders)
        queueMicrotask(() => respond!());
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  const lookup: NonNullable<GroupTextDownloadDependencies["lookup"]> = async (
    host,
    opts,
  ) => {
    dnsCalls++;
    assert.equal(host, "files.qq.example");
    assert.deepEqual(opts, { all: true, verbatim: true });
    return [{ address: "8.8.8.8", family: 4 }];
  };
  return {
    request,
    lookup,
    get options() {
      return options;
    },
    get requests() {
      return requests;
    },
    get dnsCalls() {
      return dnsCalls;
    },
    get destroyed() {
      return destroyed;
    },
    get response() {
      return response;
    },
    releaseHeaders() {
      respond!();
    },
  };
}

test("supports strict UTF8 split across chunks, whitespace, empty text and exactly the byte limit", async () => {
  const bytes = Buffer.from("你好😀\nline\tend\r\n");
  const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
  assert.equal(
    await createGroupTextDownloader(fakeNetwork(bytes, { chunks }))(
      REMOTE,
      bytes.length,
    ),
    bytes.toString(),
  );
  assert.equal(
    await createGroupTextDownloader(
      fakeNetwork(Buffer.alloc(0), { headers: { "content-length": "0" } }),
    )(REMOTE, 1),
    "",
  );
  assert.equal(
    await createGroupTextDownloader(
      fakeNetwork(Buffer.from([0xef, 0xbb, 0xbf, 0x61])),
    )(REMOTE, 4),
    "a",
  );
  assert.equal(
    (
      await createGroupTextDownloader(fakeNetwork(Buffer.alloc(262144, 0x61)))(
        REMOTE,
        262144,
      )
    ).length,
    262144,
  );
});

test("accepts native QQ HTTP public-IP links and HTTPS DNS with pinned lookup and native TLS identity", async () => {
  const fake = fakeNetwork();
  assert.equal(await createGroupTextDownloader(fake)(REMOTE, 20), "hello");
  assert.equal(fake.dnsCalls, 1);
  assert.equal(fake.options!.hostname, "files.qq.example");
  assert.equal(fake.options!.servername, "files.qq.example");
  assert.equal(fake.options!.rejectUnauthorized, true);
  assert.equal(fake.options!.agent, false);
  assert.equal(fake.options!.method, "GET");
  assert.equal(fake.options!.port, 443);
  assert.equal(fake.options!.maxHeaderSize, 16384);
  assert.equal(
    fake.options!.path,
    "/ftn_handler/PRIVATE_PATH?token=PRIVATE_TOKEN",
  );
  assert.deepEqual(fake.options!.headers, {
    Accept: "text/plain, application/octet-stream;q=0.5",
    "Accept-Encoding": "identity",
  });
  assert.equal(fake.options!.auth, undefined);
  assert.equal(fake.options!.checkServerIdentity, undefined);
  const pinned = fake.options!.lookup as Function;
  pinned(
    "rebound.example",
    {},
    (error: unknown, address: string, family: number) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
    },
  );
  pinned(
    "rebound.example",
    { all: true },
    (error: unknown, addresses: unknown) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
    },
  );
  for (const value of [
    "http://8.8.8.8/ftn_handler/token?key=secret",
    "http://8.8.8.8:80/path",
    "https://1.1.1.1:443/file",
    "http://[2606:4700:4700::1111]/file",
    "https://[2606:4700:4700::1111]/file",
  ]) {
    const literal = fakeNetwork();
    assert.equal(await createGroupTextDownloader(literal)(value, 20), "hello");
    assert.equal(literal.dnsCalls, 0);
    assert.equal(literal.requests, 1);
    assert.equal(literal.options!.servername, undefined);
    assert.equal(literal.options!.hostname?.includes("["), false);
  }
});

test("rejects dangerous URL syntax and invalid byte limits before creating any request", async () => {
  for (const value of [
    "file:///etc/passwd",
    "data:text/plain,x",
    "ftp://8.8.8.8/file",
    "//8.8.8.8/file",
    "https://u:p@8.8.8.8/file",
    "http://@8.8.8.8/file",
    "https://8.8.8.8/#secret",
    "http://8.8.8.8/#",
    "https://8.8.8.8:80/file",
    "http://8.8.8.8:443/file",
    "http://8.8.8.8:8080/file",
    " http://8.8.8.8/file",
    "http://8.8.8.8/\nfile",
    "http:\\\\8.8.8.8/file",
    "https://8.8.8.8/" + "x".repeat(8192),
    "https://[2606:4700::1111%eth0]/file",
  ]) {
    const fake = fakeNetwork();
    await assert.rejects(createGroupTextDownloader(fake)(value, 20), ERROR);
    assert.equal(fake.requests, 0);
    assert.equal(fake.dnsCalls, 0);
  }
  for (const max of [0, -1, 1.5, NaN, Infinity, 262145]) {
    const fake = fakeNetwork();
    await assert.rejects(createGroupTextDownloader(fake)(REMOTE, max), ERROR);
    assert.equal(fake.requests, 0);
    assert.equal(fake.dnsCalls, 0);
  }
});

test("rejects private metadata loopback reserved and mapped IPv6 literals without DNS or transport", async () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "[::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:8.8.8.8]",
    "[2001:db8::1]",
    "[2002:808:808::]",
  ]) {
    const fake = fakeNetwork();
    const download = createGroupTextDownloader({
      ...fake,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await assert.rejects(download(`http://${host}/PRIVATE_PATH`, 100), ERROR);
    assert.equal(fake.requests, 0, host);
  }
  // The production export rejects numeric private destinations without test hooks,
  // without performing DNS or making a network connection.
  await assert.rejects(
    downloadGroupText("http://127.0.0.1/PRIVATE_PATH", 100),
    ERROR,
  );
});

test("validates every DNS answer and never dials on mixed private records or wrong address families", async () => {
  const sets = [
    [],
    [{ address: "8.8.8.8", family: 6 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::ffff:8.8.8.8", family: 6 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "fc00::1", family: 6 },
    ],
    [{ address: "invalid", family: 4 }],
  ];
  for (const addresses of sets) {
    const fake = fakeNetwork();
    await assert.rejects(
      createGroupTextDownloader({ ...fake, lookup: async () => addresses })(
        REMOTE,
        20,
      ),
      ERROR,
    );
    assert.equal(fake.requests, 0);
  }
  const fake = fakeNetwork();
  assert.equal(
    await createGroupTextDownloader({
      ...fake,
      lookup: async () => [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "8.8.8.8", family: 4 },
      ],
    })(REMOTE, 20),
    "hello",
  );
  assert.equal(fake.options!.family, 6);
});

test("DNS rebinding cannot trigger a second lookup and environment proxy or credentials cannot alter transport options", async () => {
  const fake = fakeNetwork();
  let lookups = 0;
  const old = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://user:PRIVATE_TOKEN@127.0.0.1:1234";
  try {
    await createGroupTextDownloader({
      ...fake,
      lookup: async () => {
        lookups++;
        return [
          { address: lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
        ];
      },
    })(REMOTE, 20);
    (fake.options!.lookup as Function)(
      "files.qq.example",
      {},
      (_error: unknown, address: string) => assert.equal(address, "8.8.8.8"),
    );
    assert.equal(lookups, 1);
    assert.equal(fake.options!.agent, false);
    assert.equal(Object.hasOwn(fake.options!.headers!, "Authorization"), false);
    assert.equal(Object.hasOwn(fake.options!.headers!, "Cookie"), false);
  } finally {
    if (old === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = old;
  }
});

test("pinning captures validated primitives even if a resolver record is mutated later", async () => {
  const fake = fakeNetwork(),
    records = [{ address: "8.8.8.8", family: 4 }];
  await createGroupTextDownloader({
    ...fake,
    lookup: async () => records,
    request: (options, callback) => {
      records[0]!.address = "127.0.0.1";
      return fake.request(options, callback);
    },
  })(REMOTE, 20);
  (fake.options!.lookup as Function)(
    "ignored",
    {},
    (error: unknown, address: string, family: number) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
    },
  );
});

test("successful downloads release caller abort listeners instead of accumulating them", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 12; i++) {
    assert.equal(
      await createGroupTextDownloader(fakeNetwork())(
        REMOTE,
        20,
        controller.signal,
      ),
      "hello",
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("rejects all redirects, non-200 responses and compression without exposing response bodies", async () => {
  for (const status of [
    201, 204, 206, 301, 302, 303, 307, 308, 400, 401, 404, 500,
  ]) {
    const fake = fakeNetwork(Buffer.from("PRIVATE_TOKEN"), {
      status,
      headers: { location: "http://127.0.0.1/PRIVATE_PATH" },
    });
    await assert.rejects(createGroupTextDownloader(fake)(REMOTE, 100), ERROR);
    assert.equal(fake.requests, 1);
    assert.equal(fake.destroyed, true);
    assert.equal(fake.response!.destroyed, true);
  }
  for (const encoding of ["gzip", "br", "deflate", "identity,gzip", ""]) {
    const fake = fakeNetwork(Buffer.from("PRIVATE_TOKEN"), {
      headers: { "content-encoding": encoding },
    });
    await assert.rejects(createGroupTextDownloader(fake)(REMOTE, 100), ERROR);
    assert.equal(fake.destroyed, true);
  }
  assert.equal(
    await createGroupTextDownloader(
      fakeNetwork(Buffer.from("ok"), {
        headers: { "content-encoding": "identity" },
      }),
    )(REMOTE, 10),
    "ok",
  );
});

test("enforces declared length and streamed byte bounds without partial or truncated success", async () => {
  for (const settings of [
    { headers: { "content-length": "101" } },
    { headers: { "content-length": "1e2" } },
    { headers: { "content-length": "-1" } },
    { headers: { "content-length": "PRIVATE_TOKEN" } },
    { headers: { "content-length": ["5", "5"] } },
    {
      headers: {
        "content-length": "99999999999999999999999999999999999999999",
      },
    },
    { headers: { "content-length": "2" } },
    { headers: { "content-length": "50" } },
    { chunks: [Buffer.alloc(60, 0x61), Buffer.alloc(60, 0x61)] },
    { incomplete: true },
    { prematureClose: true },
  ] as Settings[]) {
    const fake = fakeNetwork(Buffer.from("hello"), settings);
    await assert.rejects(createGroupTextDownloader(fake)(REMOTE, 100), ERROR);
    assert.equal(fake.destroyed, true);
  }
  const early = fakeNetwork(Buffer.from("hello"), {
    synchronousHeaders: true,
    status: 302,
  });
  await assert.rejects(createGroupTextDownloader(early)(REMOTE, 100), ERROR);
  assert.equal(
    early.destroyed,
    true,
    "even synchronous rejection destroys a request returned after callback",
  );
});

test("strict UTF8 rejects malformed sequences binary NUL and abnormal controls despite text MIME", async () => {
  const invalid = [
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xff, 0xfe, 0x41, 0]),
    Buffer.from("hello\0world"),
    Buffer.from("hello\x1b[31m"),
    Buffer.from("bad\u0085text"),
    Buffer.from("bad\u007ftext"),
    Buffer.from("bad\vtext"),
    Buffer.from("bad\ftext"),
  ];
  for (const bytes of invalid)
    await assert.rejects(
      createGroupTextDownloader(
        fakeNetwork(bytes, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      )(REMOTE, 100),
      ERROR,
    );
  assert.equal(
    await createGroupTextDownloader(
      fakeNetwork(Buffer.from("普通文本"), {
        headers: { "content-type": "application/octet-stream" },
      }),
    )(REMOTE, 100),
    "普通文本",
    "MIME or filename cannot override strict byte decoding",
  );
});

test("all DNS/request/stream failures have fixed messages without paths addresses tokens or causes", async () => {
  const fake = fakeNetwork();
  for (const lookup of [
    async () => {
      throw new Error("8.8.8.8 PRIVATE_TOKEN /PRIVATE_PATH");
    },
    () => {
      throw new Error("8.8.8.8 PRIVATE_TOKEN /PRIVATE_PATH");
    },
  ])
    await assert.rejects(
      createGroupTextDownloader({ ...fake, lookup })(REMOTE, 20),
      ERROR,
    );
  await assert.rejects(
    createGroupTextDownloader({
      ...fake,
      request: () => {
        throw new Error("PRIVATE_TOKEN");
      },
    })(REMOTE, 20),
    ERROR,
  );
  for (const settings of [{ requestError: true }, { responseError: true }]) {
    const failing = fakeNetwork(Buffer.alloc(0), settings);
    await assert.rejects(
      createGroupTextDownloader(failing)(REMOTE, 20),
      (error) => {
        assert.equal((error as Error).message, "Group text download failed");
        assert.equal((error as Error).cause, undefined);
        return true;
      },
    );
    assert.equal(failing.destroyed, true);
  }
});

test("caller cancellation settles even uncooperative DNS and never opens a late connection", async () => {
  const controller = new AbortController(),
    fake = fakeNetwork();
  let complete!: (
    addresses: Array<{ address: string; family: number }>,
  ) => void;
  const work = createGroupTextDownloader({
    ...fake,
    lookup: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  })(REMOTE, 20, controller.signal);
  controller.abort(new Error("PRIVATE_TOKEN"));
  await assert.rejects(work, /^Error: Group text download aborted$/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  complete([{ address: "8.8.8.8", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.requests, 0);
  const already = new AbortController();
  already.abort("PRIVATE_TOKEN");
  await assert.rejects(
    createGroupTextDownloader(fake)(REMOTE, 20, already.signal),
    /^Error: Group text download aborted$/,
  );
  assert.equal(fake.dnsCalls, 0);
});

test("caller cancellation destroys requests while awaiting headers or receiving bodies and destroys late responses", async () => {
  for (const hang of ["headers", "body"] as const) {
    const fake = fakeNetwork(Buffer.from("partial"), { hang }),
      controller = new AbortController();
    const work = createGroupTextDownloader(fake)(
      REMOTE,
      100,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort("PRIVATE_TOKEN");
    await assert.rejects(work, /^Error: Group text download aborted$/);
    assert.equal(fake.destroyed, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    if (hang === "headers") fake.releaseHeaders();
    assert.equal(fake.response!.destroyed, true);
  }
});

test("one total deadline covers DNS headers and body; tests never wait the production fifteen seconds", async () => {
  const fake = fakeNetwork();
  await assert.rejects(
    createGroupTextDownloader({
      ...fake,
      lookup: () => new Promise(() => {}),
      timeoutMs: 10,
    })(REMOTE, 100),
    /^Error: Group text download timed out$/,
  );
  assert.equal(fake.requests, 0);
  for (const hang of ["headers", "body"] as const) {
    const network = fakeNetwork(Buffer.from("partial"), { hang });
    await assert.rejects(
      createGroupTextDownloader({ ...network, timeoutMs: 10 })(REMOTE, 100),
      /^Error: Group text download timed out$/,
    );
    assert.equal(network.destroyed, true);
    if (network.response) assert.equal(network.response.destroyed, true);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 15001])
    assert.throws(() => createGroupTextDownloader({ timeoutMs }), ERROR);
});
