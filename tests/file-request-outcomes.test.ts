import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupFileTools,
  GROUP_FILE_TOOL_NAMES,
} from "../src/group-file-tools.js";
import { GroupRequestTools } from "../src/group-request-tools.js";
import { OneBotError } from "../src/client.js";
import type { Api, JsonObject, TurnContext } from "../src/contracts.js";

const ctx: TurnContext = {
  groupId: "123",
  selfId: "456",
  actorId: "789",
  messageId: "1",
};
type Item = {
  native: string;
  name?: string;
  size?: number;
  uploader?: string;
  uploadedAt?: number;
  parent?: string;
};
const original = (): Item => ({
  native: "native-one",
  name: "report.txt",
  size: 4,
  uploader: "456",
  uploadedAt: 100,
});
function fixture() {
  const state = {
    items: [original()] as Item[],
    role: "admin",
    write: undefined as unknown,
    fail: undefined as unknown,
    hook: undefined as ((action: string) => void) | undefined,
  };
  const calls: { action: string; params: JsonObject }[] = [],
    aliases = new Map<string, string>(),
    effects: string[] = [];
  let serial = 0,
    downloads = 0;
  const rows = (parent?: string) =>
    state.items
      .filter((item) => item.parent === parent)
      .map((item) => {
        const token = `random-provider-${++serial}`;
        aliases.set(token, item.native);
        return {
          group_id: 123,
          file_id: token,
          file_name: item.name,
          file_size: item.size,
          uploader: item.uploader,
          upload_time: item.uploadedAt,
        };
      });
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params: structuredClone(params) });
      state.hook?.(action);
      if (action === "get_login_info") return { user_id: 456 };
      if (action === "get_group_member_info")
        return { group_id: 123, user_id: 456, role: state.role };
      if (action === "get_group_root_files")
        return {
          files: rows(),
          folders: [
            { group_id: 123, folder_id: "folder-a", folder_name: "a" },
            { group_id: 123, folder_id: "folder-b", folder_name: "b" },
          ],
        };
      if (action === "get_group_files_by_folder")
        return { files: rows(params.folder_id as string), folders: [] };
      if (action === "get_group_file_url") return {};
      if (state.fail) throw state.fail;
      if (action === "delete_group_file") {
        const native = aliases.get(String(params.file_id));
        if (!native || !state.items.some((x) => x.native === native))
          throw new OneBotError("api_failed", 1200);
        effects.push(native);
        return (
          state.write ?? {
            result: 0,
            errMsg: "",
            transGroupFileResult: {
              result: {},
              successFileIdList: [native],
              failFileIdList: [],
            },
          }
        );
      }
      if (action === "create_group_file_folder")
        return state.write ?? { result: {}, groupItem: {} };
      if (action === "upload_group_file")
        return state.write ?? { file_id: null };
      if (action === "delete_group_folder")
        return state.write ?? { retCode: 0 };
      throw new Error("Unexpected action");
    },
  };
  const tools = new GroupFileTools(api, ctx.groupId, GROUP_FILE_TOOL_NAMES, {
    downloader: async () => {
      downloads++;
      return "text";
    },
  });
  const run = (name: string, args: unknown, signal?: AbortSignal) =>
    tools.execute(name, args, ctx, signal);
  const list = async (folder_handle?: unknown) => {
    const r = await run("list_group_files", {
      limit: 100,
      ...(folder_handle ? { folder_handle } : {}),
    });
    assert.equal(r.status, "ok");
    return r.items as JsonObject[];
  };
  const handle = async (parent?: unknown) =>
    (await list(parent)).find((x) => x.kind === "file")!.file_handle;
  return {
    state,
    calls,
    aliases,
    effects,
    tools,
    run,
    list,
    handle,
    downloads: () => downloads,
  };
}

test("random provider tokens are only consistency aliases: fresh validation never rebinds the execution target", async () => {
  const f = fixture(),
    token = await f.handle(),
    old = [...f.aliases.keys()][0]!;
  const before = await f.tools.confirmationDetails(
    "delete_group_file",
    { file_handle: token },
    ctx,
  );
  const after = await f.tools.confirmationDetails(
    "delete_group_file",
    { file_handle: token },
    ctx,
  );
  assert.equal(before, after);
  assert.ok(f.aliases.size >= 3);
  assert.doesNotMatch(before, /random-provider|native-one/);
  const result = await f.run("delete_group_file", { file_handle: token });
  assert.equal(result.submitted, true);
  assert.equal(result.effect_confirmed, false);
  assert.deepEqual(f.effects, ["native-one"]);
  assert.equal(
    f.calls.find((c) => c.action === "delete_group_file")!.params.file_id,
    old,
  );
  assert.equal(result.deleted, undefined);
  assert.doesNotMatch(JSON.stringify(result), /native-one|random-provider/);
});

test("dynamic aliases require complete unique unchanged metadata, not a same-name guess", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      delete f.state.items[0]!.uploadedAt;
    },
    (f) => {
      delete f.state.items[0]!.size;
    },
    (f) => {
      delete f.state.items[0]!.uploader;
    },
    (f) => {
      delete f.state.items[0]!.name;
    },
    (f) => {
      f.state.items[0]!.name = '';
    },
    (f) => {
      f.state.items[0]!.name = "changed.txt";
    },
    (f) => {
      f.state.items[0]!.size = 8;
    },
    (f) => {
      f.state.items[0]!.uploader = "999";
    },
    (f) => {
      f.state.items[0]!.uploadedAt = 101;
    },
    (f) => {
      f.state.items.push({ ...original(), native: "duplicate" });
    },
    (f) => {
      f.state.items = [
        { ...original(), native: "replacement", uploadedAt: 101 },
      ];
    },
    (f) => {
      f.state.items = [
        { ...original(), parent: "folder-b" },
        { ...original(), native: "same-name-new", size: 8 },
      ];
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(),
      token = await f.handle();
    mutate(f);
    await assert.rejects(
      f.tools.confirmationDetails(
        "delete_group_file",
        { file_handle: token },
        ctx,
      ),
      /resource_not_verified/,
    );
    const result = await f.run("delete_group_file", { file_handle: token });
    assert.equal(result.error, "resource_not_verified");
    assert.equal(
      f.calls.filter((x) => x.action === "delete_group_file").length,
      0,
    );
  }
  for (const missing of ["uploadedAt", "size", "uploader", "name"] as const) {
    const f = fixture();
    delete f.state.items[0]![missing];
    const token = await f.handle();
    assert.equal(
      (await f.run("delete_group_file", { file_handle: token })).error,
      "resource_not_verified",
    );
  }
});

test("even an indistinguishable replacement cannot change the native target or recover an expired provider token", async () => {
  for (const change of ["replacement", "expired"]) {
    const f = fixture(),
      token = await f.handle(),
      old = [...f.aliases.keys()][0]!;
    if (change === "replacement")
      f.state.items = [{ ...original(), native: "other-native" }];
    else f.aliases.delete(old);
    const result = await f.run("delete_group_file", { file_handle: token });
    assert.equal(result.status, "unknown");
    assert.equal(result.provider_reported_failure, true);
    assert.deepEqual(f.effects, []);
    assert.equal(
      f.calls.find((x) => x.action === "delete_group_file")!.params.file_id,
      old,
    );
    assert.equal(
      f.calls.filter((x) => x.action === "delete_group_file").length,
      1,
    );
  }
});

test("parent membership and current role are checked independently of dynamic alias matching", async () => {
  const f = fixture();
  f.state.items[0]!.parent = "folder-a";
  const root = await f.list(),
    a = root.find((x) => x.name === "a")!.folder_handle;
  const token = await f.handle(a);
  f.state.items[0]!.parent = "folder-b";
  assert.equal(
    (await f.run("delete_group_file", { file_handle: token })).error,
    "resource_not_verified",
  );
  assert.deepEqual(f.effects, []);
  const g = fixture(),
    other = await g.handle();
  g.state.role = "member";
  g.state.items[0]!.uploader = "999";
  assert.equal(
    (await g.run("delete_group_file", { file_handle: other })).error,
    "resource_not_verified",
  );
  assert.deepEqual(g.effects, []);
});

test("submitted and unknown locks survive dynamic aliases, renames and moves without freezing independent resources", async () => {
  for (const unknown of [false, true]) {
    const f = fixture();
    if (unknown) f.state.fail = new Error("untrusted private failure");
    const token = await f.handle();
    const first = await f.run("delete_group_file", { file_handle: token });
    assert.equal(first.status, unknown ? "unknown" : "ok");
    f.tools.resetWake();
    f.state.fail = undefined;
    f.state.items[0]!.name = "renamed.txt";
    f.state.items[0]!.parent = "folder-a";
    const folder = (await f.list()).find((x) => x.name === "a")!.folder_handle,
      alias = await f.handle(folder);
    const blocked = await f.run("delete_group_file", { file_handle: alias });
    assert.equal(
      blocked.error,
      unknown ? "target_result_unknown" : "target_already_submitted",
    );
    if (!unknown) {
      assert.equal(blocked.previous_submitted, true);
      assert.equal(blocked.dispatched, false);
    }
    f.state.items.push({
      ...original(),
      native: "independent",
      name: "independent.txt",
      uploadedAt: 200,
    });
    const independent = await f.handle();
    assert.equal(
      (await f.run("delete_group_file", { file_handle: independent }))
        .submitted,
      true,
    );
    assert.equal(
      f.calls.filter((x) => x.action === "delete_group_file").length,
      2,
    );
  }
});

test("conservative immutable fingerprints can reject collisions but never authorize them", async () => {
  const f = fixture();
  const first = await f.handle();
  assert.equal(
    (await f.run("delete_group_file", { file_handle: first })).submitted,
    true,
  );
  f.tools.resetWake();
  f.state.items = [
    { ...original(), native: "different-native", name: "different.txt" },
  ];
  const collision = await f.handle();
  assert.equal(
    (await f.run("delete_group_file", { file_handle: collision })).error,
    "target_already_submitted",
  );
  assert.deepEqual(f.effects, ["native-one"]);
});

test("documented successful writes preserve native outcomes and do not invent identities", async () => {
  const f = fixture();
  const upload = await f.run("upload_group_text_file", {
    name: "note.txt",
    content: "hi",
  });
  assert.equal(upload.uploaded, true);
  assert.equal(upload.effect_confirmed, true);
  assert.equal(upload.resource_id_available, false);
  assert.equal(upload.file_id, undefined);
  const create = await f.run("create_group_folder", { name: "new" });
  assert.equal(create.submitted, true);
  assert.equal(create.effect_confirmed, false);
  f.tools.resetWake();
  const duplicate = await f.run("create_group_folder", { name: "new" });
  assert.equal(duplicate.error, "target_already_submitted");
  assert.equal(duplicate.previous_submitted, true);
  assert.equal(
    (await f.run("create_group_folder", { name: "another" })).submitted,
    true,
  );
});

test('native file success lists do not require an unverified opaque auxiliary result field',async()=>{
 for(const successFileIdList of [[],['native-id-not-provider-token']]){
  const f=fixture(), token=await f.handle();
  f.state.write={result:0,transGroupFileResult:{successFileIdList,failFileIdList:[]}};
  const result=await f.run('delete_group_file',{file_handle:token});
  assert.equal(result.submitted,true);assert.equal(result.effect_confirmed,false);
 }
});

test("known nonzero business codes including negatives are error, opaque result bodies are not invented ACKs", async () => {
  for (const code of [-1, 1, 500]) {
    const f = fixture(),
      root = await f.list(),
      folder = root.find((x) => x.kind === "folder")!.folder_handle;
    f.state.write = { retCode: code, retMsg: "SECRET" };
    assert.equal(
      (await f.run("delete_group_folder", { folder_handle: folder })).error,
      "operation_rejected",
    );
    f.state.write = { result: code, errMsg: "SECRET" };
    const file = await f.handle();
    const result = await f.run("delete_group_file", { file_handle: file });
    assert.equal(result.error, "operation_rejected");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  for (const data of [null, {}, false, { retCode: "0" }]) {
    const f = fixture(),
      folder = (await f.list()).find((x) => x.kind === "folder")!.folder_handle;
    f.state.write = data === null ? undefined : data;
    if (data === null) {
      f.state.fail = new Error("no trustworthy receipt");
    }
    assert.equal(
      (await f.run("delete_group_folder", { folder_handle: folder })).status,
      "unknown",
    );
  }
  const f = fixture(),
    token = await f.handle();
  f.state.write = {
    result: 0,
    transGroupFileResult: {
      result: {},
      successFileIdList: [],
      failFileIdList: ["native-one"],
    },
  };
  assert.equal(
    (await f.run("delete_group_file", { file_handle: token })).error,
    "operation_rejected",
  );
  const mixed = fixture(),
    m = await mixed.handle();
  mixed.state.write = {
    result: 0,
    transGroupFileResult: {
      result: {},
      successFileIdList: ["one"],
      failFileIdList: ["two"],
    },
  };
  assert.equal(
    (await mixed.run("delete_group_file", { file_handle: m }))
      .provider_reported_partial,
    true,
  );
});

test("write exception classification distinguishes proven unsent calls from handler errors after possible effects", async () => {
  for (const [error, status] of [
    [new OneBotError("unavailable"), "error"],
    [new OneBotError("busy"), "error"],
    [new OneBotError("api_failed", 1400), "error"],
    [new OneBotError("api_failed", 1200), "unknown"],
    [new OneBotError("timeout"), "unknown"],
  ] as const) {
    const f = fixture();
    f.state.fail = error;
    const result = await f.run("create_group_folder", { name: "one" });
    assert.equal(result.status, status);
    if (status === "error") assert.equal(result.dispatched, false);
    else assert.equal(result.effect_unknown, true);
  }
});

test("valid late file ACKs remain facts across cancellation and reset without resurrecting handles", async () => {
  for (const action of [
    "upload_group_text_file",
    "create_group_folder",
    "delete_group_file",
    "delete_group_folder",
  ]) {
    const f = fixture(),
      root = await f.list(),
      file = root.find((x) => x.kind === "file")!.file_handle,
      folder = root.find((x) => x.kind === "folder")!.folder_handle;
    const native = {
      upload_group_text_file: "upload_group_file",
      create_group_folder: "create_group_file_folder",
      delete_group_file: "delete_group_file",
      delete_group_folder: "delete_group_folder",
    }[action]!;
    const controller = new AbortController();
    f.state.hook = (a) => {
      if (a === native) {
        controller.abort();
        f.tools.reset();
      }
    };
    const args =
      action === "upload_group_text_file"
        ? { name: "n.txt", content: "hi" }
        : action === "create_group_folder"
          ? { name: "d" }
          : action === "delete_group_file"
            ? { file_handle: file }
            : { folder_handle: folder };
    const result = await f.run(action, args, controller.signal);
    assert.equal(result.status, "ok");
    assert.equal(result.cancelled_after_dispatch, true);
    f.state.hook = undefined;
    assert.equal(
      (await f.run("delete_group_file", { file_handle: file })).error,
      "invalid_handle",
    );
  }
});

test("optional absent file URL means content unavailable, not fake empty content or arbitrary download", async () => {
  const f = fixture(),
    token = await f.handle();
  const r = await f.run("read_group_text_file", {
    file_handle: token,
    max_bytes: 100,
  });
  assert.equal(r.error, "file_url_unavailable");
  assert.equal(r.content, undefined);
  assert.equal(f.downloads(), 0);
});

test("request late submission survives reset as a dedup fact, while error and unknown remain distinct", async () => {
  for (const mode of ["late", "bad", "schema", "timeout"]) {
    let tool: GroupRequestTools;
    let writes = 0;
    const api: Api = {
      async call(action) {
        if (action === "get_login_info") return { user_id: "456" };
        if (action === "get_group_member_info")
          return { group_id: "123", user_id: "456", role: "admin" };
        if (action === "get_group_system_msg")
          return {
            join_requests: [
              {
                request_id: 1000,
                group_id: 123,
                invitor_uin: 789,
                checked: false,
                actor: 0,
              },
            ],
            invited_requests: [],
          };
        writes++;
        if (mode === "late") {
          tool.reset();
          return null;
        }
        if (mode === "bad") throw new OneBotError("api_failed", 1400);
        if (mode === "timeout") throw new OneBotError("timeout");
        return {};
      },
    };
    tool = new GroupRequestTools(api, "123", [
      "list_group_requests",
      "respond_group_request",
    ]);
    const list = async () => {
      const r = await tool.execute("list_group_requests", { limit: 1 }, ctx);
      return (r.items as JsonObject[])[0]!.request_handle;
    };
    const token = await list();
    const args = { request_handle: token, approve: true, reason: "" };
    const result = await tool.execute("respond_group_request", args, ctx);
    assert.equal(
      result.status,
      mode === "late" ? "ok" : mode === "bad" ? "error" : "unknown",
    );
    if (mode === "late") {
      assert.equal(result.submitted, true);
      assert.equal(result.cancelled_after_dispatch, true);
      const fresh = await list();
      assert.equal(
        (
          await tool.execute(
            "respond_group_request",
            { ...args, request_handle: fresh },
            ctx,
          )
        ).cached,
        true,
      );
      assert.equal(writes, 1);
    }
  }
});
