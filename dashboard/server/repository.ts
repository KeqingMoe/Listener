import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import type {
  Availability,
  Range,
  UsageSummary,
  WakeItem,
  RequestItem,
  ToolItem,
  ToolSummary,
} from "../shared/contracts.js";
export interface GroupSource {
  groupId: string;
  sessionPath: string;
}
export interface Sources {
  groups: GroupSource[];
  telemetryPath: string;
}
type Row = Record<string, any>;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const allowed = (v: unknown, values: string[]) =>
  typeof v === "string" && values.includes(v) ? v : null;
const toolName = (v: unknown) =>
  typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : "unknown";
const percentile = (a: number[], p: number) =>
  a.length
    ? a.sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)]!
    : null;
export class ResourceLimit extends Error {}
export function summarize(rows: Row[]): UsageSummary {
  const sum = (key: string) => {
    const values = rows
      .map((r) => num(r[key]))
      .filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const known = rows.filter((r) => num(r.input_tokens) !== null),
    cached = known.filter(
      (r) =>
        num(r.cached_input_tokens) !== null &&
        r.cached_input_tokens <= r.input_tokens,
    );
  const denominator = cached.reduce((n, r) => n + r.input_tokens, 0),
    numerator = cached.reduce((n, r) => n + r.cached_input_tokens, 0),
    durations = rows
      .map((r) => num(r.duration_ms))
      .filter((n): n is number => n !== null);
  return {
    requests: rows.length,
    successes: rows.filter((r) => r.status === "success").length,
    errors: rows.filter((r) => r.status === "error").length,
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    cachedInputTokens: cached.length ? numerator : null,
    uncachedInputTokens: cached.length ? denominator - numerator : null,
    cacheHitRate: denominator ? numerator / denominator : null,
    cacheCoverage: known.length ? cached.length / known.length : null,
    knownInputRequests: known.length,
    knownCacheRequests: cached.length,
    durationP50Ms: percentile([...durations], 0.5),
    durationP95Ms: percentile([...durations], 0.95),
  };
}
export class Repository {
  private handles = new Map<string, DatabaseSync>();
  constructor(readonly sources: Sources) {}
  private open(path: string, groupId?: string): DatabaseSync | null {
    if (this.handles.has(path)) return this.handles.get(path)!;
    let db: DatabaseSync | undefined;
    try {
      if (!lstatSync(path).isFile()) return null;
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250;");
      if (groupId) {
        if (
          db
            .prepare(
              "SELECT group_id FROM model_session_meta WHERE singleton=1",
            )
            .get()?.group_id !== groupId
        ) {
          db.close();
          return null;
        }
        db.prepare("SELECT seq FROM model_session_journal LIMIT 0").all();
        db.prepare("SELECT ordinal FROM model_tool_ledger LIMIT 0").all();
        db.prepare(
          "SELECT request_id FROM model_session_messages LIMIT 0",
        ).all();
      } else db.prepare("SELECT request_id FROM model_requests LIMIT 0").all();
      this.handles.set(path, db);
      return db;
    } catch {
      try {
        db?.close();
      } catch {}
      return null;
    }
  }
  session(groupId: string) {
    const source = this.sources.groups.find((g) => g.groupId === groupId);
    return source ? this.open(source.sessionPath, groupId) : null;
  }
  availability(): Availability {
    return {
      telemetry: this.open(this.sources.telemetryPath) !== null,
      sessions: this.sources.groups.map((g) => ({
        groupId: g.groupId,
        available: this.session(g.groupId) !== null,
      })),
    };
  }
  close() {
    for (const db of this.handles.values()) db.close();
    this.handles.clear();
  }
  private bounded(rows: Row[], cap = 10000) {
    if (rows.length > cap) throw new ResourceLimit("Narrow query range");
    return rows;
  }
  requests(range: Range, groupId?: string): Row[] {
    const db = this.open(this.sources.telemetryPath);
    if (!db) return [];
    const ids = groupId ? [groupId] : this.sources.groups.map((g) => g.groupId);
    if (!ids.length) return [];
    return this.bounded(
      db
        .prepare(
          `SELECT request_id,group_id,started_at,ended_at,duration_ms,status,transport,input_tokens,output_tokens,cached_input_tokens FROM model_requests WHERE started_at>=? AND started_at<=? AND group_id IN (${ids.map(() => "?").join(",")}) ORDER BY started_at,request_id LIMIT 10001`,
        )
        .all(range.since, range.until, ...ids) as Row[],
    );
  }
  private finish(db: DatabaseSync, wakeId: string) {
    const row = db
      .prepare(
        "SELECT created_at,CASE WHEN json_valid(payload) THEN json_extract(payload,'$.reason') ELSE NULL END AS reason FROM model_session_journal WHERE wake_id=? AND kind='wake_finish' ORDER BY seq DESC LIMIT 1",
      )
      .get(wakeId);
    return {
      finishedAt: num(row?.created_at),
      outcome: allowed(row?.reason, [
        "finish",
        "silent",
        "replied",
        "prose_suppressed",
        "cancelled",
        "model_failed",
        "delivery_unknown",
        "tool_budget_exhausted",
        "wake_timeout",
        "budget_exhausted",
        "completed",
        "response_state_expired",
        "error",
        "failed",
        "operation_submitted",
        "message_submitted",
        "reaction_submitted",
        "reaction_unknown",
        "reacted",
        "reaction_failed",
        "partial_reply_cancelled",
        "partial_reaction_cancelled",
        "partial_management_cancelled",
      ]),
    };
  }
  private wake(
    db: DatabaseSync,
    groupId: string,
    row: Row,
    requests: Row[],
  ): WakeItem {
    const finish = this.finish(db, row.wake_id),
      ids = new Set(
        db
          .prepare(
            "SELECT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001",
          )
          .all(row.wake_id)
          .map((r) => r.request_id),
      );
    if (ids.size > 10000) throw new ResourceLimit();
    const usage = summarize(
      requests.filter((r) => r.group_id === groupId && ids.has(r.request_id)),
    );
    return {
      wakeId: row.wake_id,
      groupId,
      sessionId: row.session_id,
      startedAt: row.created_at,
      ...finish,
      durationMs:
        finish.finishedAt !== null
          ? Math.max(0, finish.finishedAt - row.created_at)
          : null,
      trigger: null,
      modelRequests: usage.requests,
      toolCalls: Number(
        db
          .prepare("SELECT COUNT(*) n FROM model_tool_ledger WHERE wake_id=?")
          .get(row.wake_id)!.n,
      ),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  private wakeRequests(
    db: DatabaseSync,
    groupId: string,
    wakeId: string,
  ): Row[] {
    const telemetry = this.open(this.sources.telemetryPath);
    if (!telemetry) return [];
    const ids = this.bounded(
      db
        .prepare(
          "SELECT DISTINCT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001",
        )
        .all(wakeId) as Row[],
    ).map((r) => r.request_id);
    const result: Row[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      result.push(
        ...(telemetry
          .prepare(
            `SELECT request_id,group_id,started_at,ended_at,duration_ms,status,transport,input_tokens,output_tokens,cached_input_tokens FROM model_requests WHERE group_id=? AND request_id IN (${batch.map(() => "?").join(",")}) ORDER BY started_at,request_id`,
          )
          .all(groupId, ...batch) as Row[]),
      );
    }
    return result.sort((a, b) => a.started_at - b.started_at);
  }
  wakes(
    range: Range,
    groupId: string | undefined,
    offset: number,
    limit: number,
  ) {
    const result: Array<{ groupId: string; row: Row; db: DatabaseSync }> = [];
    for (const g of this.sources.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const db = this.session(g.groupId);
      if (!db) continue;
      const rows = db
        .prepare(
          "SELECT seq,wake_id,session_id,created_at FROM model_session_journal WHERE kind='wake_begin' AND created_at>=? AND created_at<=? ORDER BY created_at DESC,wake_id ASC LIMIT ?",
        )
        .all(range.since, range.until, offset + limit + 1) as Row[];
      for (const row of rows) result.push({ groupId: g.groupId, row, db });
    }
    result.sort(
      (a, b) =>
        b.row.created_at - a.row.created_at ||
        a.groupId.localeCompare(b.groupId) ||
        a.row.wake_id.localeCompare(b.row.wake_id),
    );
    return {
      items: result
        .slice(offset, offset + limit)
        .map(({ groupId, row, db }) =>
          this.wake(
            db,
            groupId,
            row,
            this.wakeRequests(db, groupId, row.wake_id),
          ),
        ),
      hasMore: result.length > offset + limit,
    };
  }
  detail(groupId: string, wakeId: string) {
    const db = this.session(groupId);
    if (!db) return null;
    const row = db
      .prepare(
        "SELECT wake_id,session_id,created_at FROM model_session_journal WHERE kind='wake_begin' AND wake_id=? LIMIT 1",
      )
      .get(wakeId) as Row | undefined;
    if (!row) return null;
    const raw = this.wakeRequests(db, groupId, wakeId),
      wake = this.wake(db, groupId, row, raw),
      ids = new Set(
        db
          .prepare(
            "SELECT request_id FROM model_session_messages WHERE wake_id=? AND request_id IS NOT NULL LIMIT 10001",
          )
          .all(wakeId)
          .map((r) => r.request_id),
      );
    const allRequests = raw.filter((r) => ids.has(r.request_id));
    const requests: RequestItem[] = allRequests
      .slice(0, 500)
      .map((r) => ({
        requestId: r.request_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        status: (allowed(r.status, ["success", "error"]) ??
          "unknown") as RequestItem["status"],
        transport: (allowed(r.transport, ["chat", "responses"]) ??
          "unknown") as RequestItem["transport"],
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        cachedInputTokens: num(r.cached_input_tokens),
      }));
    const rows = db
      .prepare(
        "SELECT ordinal,name,state,proposed_at,started_at,finished_at,CASE WHEN json_valid(result) THEN json_extract(result,'$.status') ELSE NULL END AS status FROM model_tool_ledger WHERE wake_id=? ORDER BY ordinal LIMIT 501",
      )
      .all(wakeId) as Row[];
    const tools: ToolItem[] = rows
      .slice(0, 500)
      .map((r) => ({
        ordinal: r.ordinal,
        name: toolName(r.name),
        state:
          allowed(r.state, [
            "pending",
            "started",
            "finished",
            "unknown",
            "skipped",
          ]) ?? "unknown",
        proposedAt: r.proposed_at,
        startedAt: num(r.started_at),
        finishedAt: num(r.finished_at),
        durationMs:
          num(r.started_at) !== null && num(r.finished_at) !== null
            ? Math.max(0, r.finished_at - r.started_at)
            : null,
        status: allowed(r.status, [
          "ok",
          "error",
          "unknown",
          "skipped",
          "staged",
          "executed",
          "pending",
          "confirmation_required",
          "duplicate",
          "success",
        ]),
      }));
    return {
      wake,
      requests,
      tools,
      truncated: rows.length > 500 || allRequests.length > 500,
      availability: this.availability(),
    };
  }
  tools(range: Range, groupId?: string): ToolSummary[] {
    const byName = new Map<string, Row[]>();
    let count = 0;
    for (const g of this.sources.groups.filter(
      (g) => !groupId || g.groupId === groupId,
    )) {
      const db = this.session(g.groupId);
      if (!db) continue;
      const rows = this.bounded(
        db
          .prepare(
            "SELECT name,state,started_at,finished_at,CASE WHEN json_valid(result) THEN json_extract(result,'$.status') ELSE NULL END AS status FROM model_tool_ledger WHERE proposed_at>=? AND proposed_at<=? LIMIT 10001",
          )
          .all(range.since, range.until) as Row[],
      );
      count += rows.length;
      if (count > 10000) throw new ResourceLimit();
      for (const row of rows) {
        const name = toolName(row.name);
        const a = byName.get(name) ?? [];
        a.push(row);
        byName.set(name, a);
      }
    }
    return [...byName]
      .map(([name, rows]) => {
        const durations = rows
          .filter(
            (r) => num(r.started_at) !== null && num(r.finished_at) !== null,
          )
          .map((r) => Math.max(0, r.finished_at - r.started_at));
        const n = (state: string) =>
          rows.filter((r) => r.state === state).length;
        return {
          name,
          calls: rows.length,
          finished: n("finished"),
          pending: n("pending"),
          started: n("started"),
          unknown: rows.filter(
            (r) =>
              !["pending", "started", "skipped"].includes(r.state) &&
              (r.state === "unknown" ||
                ![
                  "ok",
                  "executed",
                  "pending",
                  "confirmation_required",
                  "staged",
                  "duplicate",
                  "success",
                  "error",
                  "skipped",
                ].includes(r.status)),
          ).length,
          skipped: rows.filter(
            (r) =>
              r.state === "skipped" ||
              (!["pending", "started", "unknown"].includes(r.state) &&
                r.status === "skipped"),
          ).length,
          errors: rows.filter(
            (r) =>
              !["pending", "started", "unknown", "skipped"].includes(r.state) &&
              r.status === "error",
          ).length,
          durationP50Ms: percentile([...durations], 0.5),
          durationP95Ms: percentile([...durations], 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  }
}
