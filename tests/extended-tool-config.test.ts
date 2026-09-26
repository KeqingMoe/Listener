import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, ConfigError } from "../src/config-loader.js";
import {
  EXTENDED_TOOL_NAMES,
  EXTENDED_READ_ONLY_TOOLS,
  enabledExtendedTools,
} from "../src/extended-tool-config.js";
test("configuration example enumerates every extension without granting any capability", (t) => {
  const config = fixture(t)(
    readFileSync(
      join(import.meta.dirname, "..", "config.example.toml"),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.keys(config.listener.tools!.extended!).sort(),
    [...EXTENDED_TOOL_NAMES].sort(),
  );
  assert.ok(
    Object.values(config.listener.tools!.extended!).every(
      (mode) => mode === "off",
    ),
  );
  assert.deepEqual(enabledExtendedTools(config.listener.tools!.extended), []);
});
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "extended-tools-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/listener.md"), "synthetic persona");
  return (text: string) => {
    // Keep explicit bot inputs (including the distributed example) unchanged.
    const source = /^\s*\[bot\]/m.test(text)
      ? text
      : text + '\n[bot]\nowner_id="778899"\n';
    writeFileSync(join(dir, "config.toml"), source);
    return loadAppConfig({
      configPath: join(dir, "config.toml"),
      env: { ONEBOT_ACCESS_TOKEN: "fixture" },
    });
  };
}
test("new tools are off by default including high-impact capabilities", (t) => {
  const config = fixture(t)("");
  assert.equal(config.listener.tools?.extended, undefined);
  assert.deepEqual(enabledExtendedTools(config.listener.tools?.extended), []);
  for (const name of EXTENDED_TOOL_NAMES)
    assert.deepEqual(enabledExtendedTools({ [name]: "off" }), []);
});
test("each extended capability requires explicit direct and remains group scoped", (t) => {
  const load = fixture(t);
  for (const name of EXTENDED_TOOL_NAMES)
    assert.deepEqual(
      enabledExtendedTools(
        load(`[tools.extended]\n${name}="direct"`).listener.tools?.extended,
      ),
      [name],
    );
  const config = load(
    '[tools.extended]\nget_group_info="direct"\nkick_member="off"\n[groups."1".tools.extended]\nkick_member="direct"\n[groups."2".tools.extended]\nget_group_info="off"',
  );
  assert.deepEqual(enabledExtendedTools(config.groups[0]!.tools?.extended), [
    "get_group_info",
    "kick_member",
  ]);
  assert.deepEqual(enabledExtendedTools(config.groups[1]!.tools?.extended), []);
  assert.deepEqual(enabledExtendedTools(config.listener.tools?.extended), [
    "get_group_info",
  ]);
  config.groups[0]!.tools!.extended!.get_group_info = "off";
  assert.equal(config.listener.tools!.extended!.get_group_info, "direct");
});
test("write capabilities support confirm and inherit independently without enabling direct execution", (t) => {
  const load = fixture(t);
  for (const name of EXTENDED_TOOL_NAMES) {
    if (EXTENDED_READ_ONLY_TOOLS.includes(name))
      assert.throws(
        () => load(`[tools.extended]\n${name}="confirm"`),
        ConfigError,
      );
    else
      assert.equal(
        load(`[tools.extended]\n${name}="confirm"`).listener.tools!.extended![
          name
        ],
        "confirm",
      );
  }
  const config = load(
    '[tools.extended]\nkick_member="confirm"\ndelete_group_file="confirm"\n[groups."1".tools.extended]\nkick_member="off"\n[groups."2".tools.extended]\nkick_member="direct"',
  );
  assert.equal(config.groups[0]!.tools!.extended!.kick_member, "off");
  assert.equal(config.groups[0]!.tools!.extended!.delete_group_file, "confirm");
  assert.equal(config.groups[1]!.tools!.extended!.kick_member, "direct");
  assert.equal(config.listener.tools!.extended!.kick_member, "confirm");
});
test("unknown names and implicit or unsupported modes fail even in disabled groups", (t) => {
  const load = fixture(t);
  for (const prefix of [
    "[tools.extended]",
    '[groups."1"]\nenabled=false\n[groups."1".tools.extended]',
  ]) {
    for (const value of ["true", "false", '"on"', "1", "[]", "{}"])
      assert.throws(() => load(`${prefix}\nkick_member=${value}`), ConfigError);
    assert.throws(() => load(`${prefix}\nunknown_tool="direct"`), ConfigError);
  }
});
