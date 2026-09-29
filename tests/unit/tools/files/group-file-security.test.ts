import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../../../src/artifacts/store.js";
import assert from "node:assert/strict";
import {
  GroupFileTools,
  GROUP_FILE_TOOL_NAMES,
} from "../../../../src/tools/files/tools.js";
import type { Api } from "../../../../src/contracts/onebot.js";
import type { JsonObject } from "../../../../src/contracts/json.js";
import type { TurnContext } from "../../../../src/contracts/tools.js";
const artifactDir = mkdtempSync(join(tmpdir(), "group-file-security-"));
const store = new ArtifactStore({
  path: join(artifactDir, "a.sqlite"),
  directory: join(artifactDir, "files"),
  providerDirectory: "/napcat/artifacts",
});
after(() => {
  store.close();
  rmSync(artifactDir, { recursive: true, force: true });
});
const art = async (name: string, content = "safe", groupId = "123") =>
  (
    await store.create({
      selfId: "456",
      groupId,
      name,
      description: "测试产物",
      mediaType: "text/plain",
      ttlMs: 60000,
      bytes: Buffer.from(content),
    })
  ).artifactId;
const ctx: TurnContext = {
  groupId: "123",
  selfId: "456",
  actorId: "789",
  messageId: "1",
};
const file = (extra: JsonObject = {}) => ({
  group_id: "123",
  file_id: "encoded-file-identity",
  file_name: "safe.txt",
  file_size: 4,
  uploader: "456",
  ...extra,
});
const folder = () => ({
  group_id: "123",
  folder_id: "native-folder",
  folder_name: "folder",
});
function fixture(
  options: {
    role?: string;
    reply?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
  } = {},
) {
  const calls: Array<{ action: string; params: JsonObject }> = [];
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      const override = await options.reply?.(action, params);
      if (override !== undefined) return override;
      if (action === "get_login_info") return { user_id: ctx.selfId };
      if (action === "get_group_member_info")
        return {
          group_id: ctx.groupId,
          user_id: ctx.selfId,
          role: options.role ?? "admin",
        };
      if (action === "get_group_root_files")
        return { files: [file()], folders: [folder()] };
      if (action === "get_group_files_by_folder")
        return { files: [file()], folders: [] };
      if (action === "get_group_file_system_info")
        return {
          file_count: 1,
          limit_count: 10000,
          used_space: 4,
          total_space: 100,
        };
      if (action === "get_group_file_url")
        return { url: "https://qq-native.example.invalid/opaque-token" };
      if (action === "upload_group_file") return { file_id: "native-upload" };
      if (action === "delete_group_file" || action === "delete_group_folder")
        return null;
      throw new Error("Unexpected offline fixture action " + action);
    },
  };
  const tools = new GroupFileTools(api, ctx.groupId, GROUP_FILE_TOOL_NAMES, {
    downloader: async () => "safe",
    artifacts: store,
  });
  const run = (name: string, args: unknown) => tools.execute(name, args, ctx);
  const list = async (args: JsonObject = {}) => {
    const value = await run("list_group_files", { limit: 20, ...args });
    assert.equal(value.status, "ok");
    return value.items as JsonObject[];
  };
  return { tools, calls, run, list };
}

test("security: one raw file unknown lock survives alternate opaque handles from different parent listings", async () => {
  const f = fixture(),
    root = await f.list();
  const oldHandle = root.find((r) => r.kind === "file")!.file_handle,
    folderHandle = root.find((r) => r.kind === "folder")!.folder_handle;
  // A file moved between listings (or duplicate native listing) is the same raw
  // file identity, even if two valid opaque tokens were issued for its parents.
  const nested = await f.list({ folder_handle: folderHandle });
  const otherHandle = nested.find((r) => r.kind === "file")!.file_handle;
  assert.equal(
    (await f.run("delete_group_file", { file_handle: oldHandle })).status,
    "unknown",
  );
  await f.run("delete_group_file", { file_handle: otherHandle });
  assert.equal(
    f.calls.filter((c) => c.action === "delete_group_file").length,
    1,
    "same raw file must not be dispatched again after unknown",
  );
});

test("security: unknown folder deletion prevents new writes targeting that folder", async () => {
  const f = fixture(),
    rows = await f.list(),
    folderHandle = rows.find((r) => r.kind === "folder")!.folder_handle;
  assert.equal(
    (await f.run("delete_group_folder", { folder_handle: folderHandle }))
      .status,
    "unknown",
  );
  await f.run("upload_group_file", {
    folder_handle: folderHandle,
    artifact_id: await art("new.txt"),
  });
  assert.equal(
    f.calls.filter((c) => c.action === "upload_group_file").length,
    0,
    "uncertain folder existence must lock writes into the folder",
  );
});

test("security: delete result naming an unrelated native file does not confirm this deletion", async () => {
  const f = fixture({
    reply: (action) =>
      action === "delete_group_file"
        ? {
            result: 0,
            transGroupFileResult: {
              result: 0,
              successFileIdList: ["UNRELATED-NATIVE-FILE"],
              failFileIdList: [],
            },
          }
        : undefined,
  });
  const rows = await f.list(),
    token = rows.find((r) => r.kind === "file")!.file_handle;
  const result = await f.run('delete_group_file',{file_handle:token});
  assert.equal(result.status,'ok');
  assert.equal(result.submitted,true);
  assert.equal(result.effect_confirmed,false,'native success list is API reported completion, not independent identity/physical deletion proof');
  assert.equal(result.deleted,undefined);
  assert.equal(JSON.stringify(result).includes('UNRELATED-NATIVE-FILE'),false);
});

test("security: destructive file operation checks current directory membership before dispatch", async () => {
  let removed = false;
  const f = fixture({
    role: "member",
    reply: (action) =>
      removed && action === "get_group_root_files"
        ? { files: [], folders: [folder()] }
        : undefined,
  });
  const rows = await f.list(),
    token = rows.find((r) => r.kind === "file")!.file_handle;
  removed = true;
  await f.run("delete_group_file", { file_handle: token });
  assert.equal(
    f.calls.filter((c) => c.action === "delete_group_file").length,
    0,
    "a historical uploader handle is not current file membership proof",
  );
});

test("security: supplied group identity in capacity or listing responses cannot contradict current group", async () => {
  for (const action of ["get_group_file_system_info", "get_group_root_files"]) {
    const f = fixture({
      reply: (a) =>
        a === action
          ? action === "get_group_file_system_info"
            ? {
                group_id: "999",
                file_count: 1,
                limit_count: 10,
                used_space: 0,
                total_space: 20,
              }
            : { group_id: "999", files: [file()], folders: [] }
          : undefined,
    });
    assert.equal(
      (
        await f.run(
          action === "get_group_file_system_info"
            ? "get_group_file_space"
            : "list_group_files",
          action === "get_group_file_system_info" ? {} : { limit: 1 },
        )
      ).status,
      "error",
      "explicit foreign group must fail closed",
    );
  }
});

test("security: accessors are rejected without invoking untrusted getters", async () => {
  const f = fixture();
  let invoked = 0;
  const artifact_id = await art("safe.txt");
  const args = Object.defineProperty({ artifact_id }, "folder_handle", {
    enumerable: true,
    get() {
      invoked++;
      return "safe";
    },
  });
  assert.equal((await f.run("upload_group_file", args)).status, "error");
  assert.equal(invoked, 0);
  assert.equal(f.calls.length, 0);
});

test("security: upload sends only the scoped artifact shared path, never model-supplied paths, URLs or base64", async () => {
  const f = fixture(),
    content =
      "file:///etc/private https://private.example.invalid/token /home/secret";
  const artifact_id = await art("literal.txt", content);
  assert.equal(
    (await f.run("upload_group_file", { artifact_id })).status,
    "ok",
  );
  const upload = f.calls.find((c) => c.action === "upload_group_file")!;
  assert.equal(upload.params.file, `/napcat/artifacts/${artifact_id}`);
  assert.ok(!String(upload.params.file).startsWith("base64://"));
  assert.doesNotMatch(JSON.stringify(upload.params), /private|secret/);
  assert.equal(upload.params.name, "literal.txt");
  for (const file of [
    "/etc/passwd",
    "file:///etc/private",
    "https://private.example.invalid/token",
    "base64://c2VjcmV0",
  ]) {
    assert.equal(
      (await f.run("upload_group_file", { artifact_id, file })).error,
      "invalid_arguments",
    );
    assert.equal(
      (await f.run("upload_group_file", { artifact_id: file })).error,
      "invalid_arguments",
    );
  }
  assert.equal(
    (
      await f.run("upload_group_file", {
        artifact_id: await art("foreign.txt", "x", "999"),
      })
    ).error,
    "artifact_not_found",
  );
  assert.equal(
    f.calls.filter((c) => c.action === "upload_group_file").length,
    1,
  );
});

test("security: foreign or missing per-row group identity never produces an opaque handle", async () => {
  for (const group_id of ["999", undefined]) {
    const f = fixture({
      reply: (action) =>
        action === "get_group_root_files"
          ? { files: [file({ group_id })], folders: [] }
          : undefined,
    });
    const result = await f.run("list_group_files", { limit: 20 });
    assert.equal(result.status, "error");
    assert.equal(result.items, undefined);
  }
});
