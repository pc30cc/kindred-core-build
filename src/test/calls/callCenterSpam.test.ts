/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * Call Center — mark as spam / not spam.
 *
 * Covers POST /api/call-center/calls/:id/spam and /not-spam against an
 * in-memory Supabase double:
 *   - metadata.spam is written via compare-and-set (other metadata keys,
 *     including ones written concurrently, survive)
 *   - the contact identity is flagged exactly like conversation spam
 *     (contacts.is_spam + every conversation of that contact)
 *   - a call still waiting in the queue is taken out of line via the
 *     reject path; an answered call keeps running
 *   - not-spam clears metadata.spam and the contact flag only
 * Plus the refactored markSpam / unmarkSpam keep their behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, any>;

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";
const OPERATOR = "u-1";

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Fired before a call_sessions update is applied (lets a test race it). */
  beforeCallUpdate: null as null | ((filters: Array<[string, unknown]>) => void),
  /** Fired when call_queue_entries is read. */
  onQueueRead: null as null | (() => void),
  tick: 0,
  publishOperatorEvent: vi.fn(),
  publishQueueEvent: vi.fn(),
  publishCallEvent: vi.fn(),
  cancelRing: vi.fn(),
}));

/** Rows are plain JSON; copy so the route never holds live references. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function makeQuery(table: string) {
  const filters: Array<[string, unknown]> = [];
  const preds: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" = "select";
  let patch: Row = {};
  let returning = false;

  const rows = () => (h.db[table] ||= []);
  const matches = () => rows().filter((r) => preds.every((p) => p(r)));

  async function exec(single: boolean) {
    if (op === "update") {
      if (table === "call_sessions" && h.beforeCallUpdate) h.beforeCallUpdate(filters);
      const hit = matches();
      for (const r of hit) {
        Object.assign(r, clone(patch));
        // trg_call_sessions_updated_at
        if (table === "call_sessions") r.updated_at = `t${++h.tick}`;
      }
      const out = hit.map((r) => clone(r));
      if (!returning) return { data: null, error: null };
      return { data: single ? out[0] ?? null : out, error: null };
    }
    if (table === "call_queue_entries" && h.onQueueRead) h.onQueueRead();
    const out = matches().map((r) => clone(r));
    return { data: single ? out[0] ?? null : out, error: null };
  }

  const b: any = {
    select() { if (op === "update") returning = true; return b; },
    eq(k: string, v: unknown) { filters.push([k, v]); preds.push((r) => r[k] === v); return b; },
    neq(k: string, v: unknown) { preds.push((r) => r[k] !== v); return b; },
    in(k: string, vs: unknown[]) { preds.push((r) => vs.includes(r[k])); return b; },
    is(k: string, v: unknown) { preds.push((r) => (r[k] ?? null) === v); return b; },
    order() { return b; },
    range() { return b; },
    limit() { return b; },
    update(p: Row) { op = "update"; patch = p; return b; },
    insert(row: Row | Row[]) {
      for (const r of Array.isArray(row) ? row : [row]) rows().push(clone(r));
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle: () => exec(true),
    single: () => exec(true),
    then(res: any, rej: any) { return exec(false).then(res, rej); },
  };
  return b;
}

const sbMock = {
  from: (t: string) => makeQuery(t),
  rpc: async (name: string) => {
    if (name === "is_workspace_member") return { data: true, error: null };
    if (name === "get_workspace_role") return { data: "agent", error: null };
    return { data: null, error: null };
  },
};

vi.mock("../../../server/supabase.js", () => ({ getServiceClient: () => sbMock }));
vi.mock("../../../server/middleware/adminBypass.js", () => ({ isGlobalAdmin: async () => true }));
vi.mock("../../../server/services/auth/sessions.js", () => ({
  SESSION_COOKIE_NAME: "gs_session",
  validateSessionToken: async (_c: unknown, token: string | undefined) =>
    token ? { sessionId: "s", userId: OPERATOR, email: "op@example.com" } : null,
  verifyOriginForMutation: () => true,
}));
vi.mock("../../../server/services/realtime/publish.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  publishOperatorEvent: h.publishOperatorEvent,
}));
vi.mock("../../../server/services/callCenter/realtime.js", () => ({
  publishQueueEvent: h.publishQueueEvent,
  publishCallEvent: h.publishCallEvent,
}));
vi.mock("../../../server/services/push/callRing.js", () => ({ cancelRing: h.cancelRing }));

import { callCenterRouter } from "../../../server/routes/callCenter";
import { markSpam, unmarkSpam } from "../../../server/services/spam/state";

function findHandler(method: string, path: string) {
  const layer = (callCenterRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  const stk = layer.route.stack;
  return stk[stk.length - 1].handle;
}

async function call(method: "get" | "post", path: string, opts: { id?: string; query?: Row; body?: Row } = {}) {
  const req: any = {
    method: method.toUpperCase(),
    params: { id: opts.id ?? "call-1" },
    query: opts.query ?? { workspaceId: WS },
    body: opts.body ?? {},
    headers: { authorization: "Bearer t" },
    cookies: {},
    serverConfig: { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" },
  };
  let statusCode = 200;
  let jsonBody: any;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: any) { jsonBody = b; return res; },
  };
  await findHandler(method, path)(req, res, () => {});
  return { status: statusCode, body: jsonBody };
}

const callRow = (id: string) => h.db.call_sessions.find((r) => r.id === id)!;
const queueRow = (callId: string) => h.db.call_queue_entries.find((r) => r.call_session_id === callId)!;

function seed() {
  h.tick = 0;
  h.beforeCallUpdate = null;
  h.onQueueRead = null;
  h.db = {
    call_sessions: [
      {
        id: "call-1", workspace_id: WS, entry_source: "call_widget", state: "pending",
        connected_at: null, assigned_agent_id: null, updated_at: "t0",
        metadata: {
          call_center: true, contact_id: "contact-1",
          operator_notes: [{ id: "n1", note: "keep me" }],
          recording: { state: "ready" },
        },
      },
      {
        id: "call-active", workspace_id: WS, entry_source: "call_widget", state: "active",
        connected_at: "2026-09-24T10:00:00Z", assigned_agent_id: OPERATOR, updated_at: "t0",
        metadata: { contact_id: "contact-1", recording: { recording_id: "egress-1" } },
      },
      {
        id: "call-anon", workspace_id: WS, entry_source: "call_widget", state: "pending",
        connected_at: null, updated_at: "t0", metadata: { contact_id: null },
      },
      {
        id: "call-foreign-contact", workspace_id: WS, entry_source: "call_widget", state: "ended",
        connected_at: null, updated_at: "t0", metadata: { contact_id: "contact-other-ws" },
      },
      {
        id: "call-chat", workspace_id: WS, entry_source: "chat", state: "active",
        connected_at: null, updated_at: "t0", metadata: {},
      },
      {
        id: "call-elsewhere", workspace_id: OTHER_WS, entry_source: "call_widget", state: "pending",
        connected_at: null, updated_at: "t0", metadata: {},
      },
    ],
    call_queue_entries: [
      { id: "q-1", workspace_id: WS, call_session_id: "call-1", state: "queued", contact_id: "contact-1", ended_reason: null },
      { id: "q-active", workspace_id: WS, call_session_id: "call-active", state: "accepted", contact_id: "contact-1", ended_reason: null },
      { id: "q-anon", workspace_id: WS, call_session_id: "call-anon", state: "offered", contact_id: null, ended_reason: null },
    ],
    contacts: [
      { id: "contact-1", workspace_id: WS, is_spam: false, spam_marked_at: null, spam_marked_by: null },
      { id: "contact-2", workspace_id: WS, is_spam: false, spam_marked_at: null, spam_marked_by: null },
      { id: "contact-other-ws", workspace_id: OTHER_WS, is_spam: false, spam_marked_at: null, spam_marked_by: null },
    ],
    conversations: [
      { id: "conv-a", workspace_id: WS, contact_id: "contact-1", is_spam: false },
      { id: "conv-b", workspace_id: WS, contact_id: "contact-1", is_spam: false },
      { id: "conv-c", workspace_id: WS, contact_id: "contact-2", is_spam: false },
      { id: "conv-anon", workspace_id: WS, contact_id: null, is_spam: false },
    ],
    call_events: [],
  };
}

beforeEach(() => {
  seed();
  h.publishOperatorEvent.mockReset();
  h.publishQueueEvent.mockReset();
  h.publishCallEvent.mockReset();
  h.cancelRing.mockReset();
});

describe("POST /calls/:id/spam", () => {
  it("flags a waiting call + its contact identity and takes the call out of the queue", async () => {
    const r = await call("post", "/calls/:id/spam");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      call_id: "call-1",
      contact_id: "contact-1",
      conversation_ids: ["conv-a", "conv-b"],
      spam: true,
      removed_from_queue: true,
    });

    const c = callRow("call-1");
    expect(c.metadata.spam).toEqual({ marked_at: expect.any(String), marked_by: OPERATOR });
    // Other metadata keys are never clobbered.
    expect(c.metadata.operator_notes).toEqual([{ id: "n1", note: "keep me" }]);
    expect(c.metadata.recording).toEqual({ state: "ready" });
    expect(c.metadata.call_center_reason).toBe("operator_marked_spam");
    // Same shape as reject: cancelled with the canonical end_reason.
    expect(c.state).toBe("cancelled");
    expect(c.end_reason).toBe("operator_ended");
    expect(c.ended_by).toBe("operator");
    expect(c.ended_by_user_id).toBe(OPERATOR);
    expect(queueRow("call-1")).toMatchObject({ state: "cancelled", ended_reason: "spam" });
    expect(h.publishQueueEvent).toHaveBeenCalledWith(expect.anything(), WS, "call_rejected", { call_id: "call-1" });
    // Every phone stops ringing, not only the actor's.
    expect(h.cancelRing).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS, callSessionId: "call-1", reason: "cancelled",
    });

    // Contact identity flagged exactly like conversation spam.
    const contact = h.db.contacts.find((x) => x.id === "contact-1")!;
    expect(contact).toMatchObject({ is_spam: true, spam_marked_by: OPERATOR });
    expect(contact.spam_marked_at).toBe(c.metadata.spam.marked_at);
    const convs = Object.fromEntries(h.db.conversations.map((x) => [x.id, x.is_spam]));
    expect(convs).toEqual({ "conv-a": true, "conv-b": true, "conv-c": false, "conv-anon": false });

    // One spam_changed per touched conversation, same payload as the conversation route.
    expect(h.publishOperatorEvent).toHaveBeenCalledTimes(2);
    for (const cid of ["conv-a", "conv-b"]) {
      expect(h.publishOperatorEvent).toHaveBeenCalledWith(expect.anything(), {
        kind: "spam_changed",
        conversation_id: cid,
        workspace_id: WS,
        actor_id: OPERATOR,
        is_spam: true,
        contact_id: "contact-1",
      });
    }
    expect(h.db.call_events.map((e) => e.event_type)).toEqual(["call_rejected", "call_marked_spam"]);
  });

  it("does not end an answered call", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-active" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ call_id: "call-active", spam: true, removed_from_queue: false });
    const c = callRow("call-active");
    expect(c.state).toBe("active");
    expect(c.end_reason).toBeUndefined();
    expect(c.metadata.spam.marked_by).toBe(OPERATOR);
    expect(c.metadata.recording).toEqual({ recording_id: "egress-1" });
    expect(queueRow("call-active").state).toBe("accepted");
    expect(h.cancelRing).not.toHaveBeenCalled();
    expect(h.publishQueueEvent).not.toHaveBeenCalled();
  });

  it("leaves a call answered mid-request running (guarded transition)", async () => {
    // Operator accepts between the spam route's read and its dequeue.
    h.onQueueRead = () => {
      const c = callRow("call-1");
      c.state = "active";
      c.connected_at = "2026-09-24T10:00:00Z";
      h.onQueueRead = null;
    };
    const r = await call("post", "/calls/:id/spam");
    expect(r.status).toBe(200);
    expect(r.body.removed_from_queue).toBe(false);
    expect(callRow("call-1").state).toBe("active");
    expect(queueRow("call-1").state).toBe("queued");
    expect(h.cancelRing).not.toHaveBeenCalled();
    expect(h.db.call_events.map((e) => e.event_type)).toEqual(["call_marked_spam"]);
  });

  it("anonymous call: only the call is flagged", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-anon" });
    expect(r.body).toMatchObject({ contact_id: null, conversation_ids: [], spam: true, removed_from_queue: true });
    expect(queueRow("call-anon")).toMatchObject({ state: "cancelled", ended_reason: "spam" });
    expect(h.db.contacts.every((x) => !x.is_spam)).toBe(true);
    expect(h.db.conversations.every((x) => !x.is_spam)).toBe(true);
    expect(h.publishOperatorEvent).not.toHaveBeenCalled();
  });

  it("ignores a contact id that does not belong to the workspace", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-foreign-contact" });
    expect(r.body).toMatchObject({ contact_id: null, conversation_ids: [], removed_from_queue: false });
    expect(h.db.contacts.find((x) => x.id === "contact-other-ws")!.is_spam).toBe(false);
  });

  it("merges onto a concurrent metadata write instead of clobbering it (CAS retry)", async () => {
    let raced = false;
    h.beforeCallUpdate = (filters) => {
      if (raced || !filters.some(([k]) => k === "updated_at")) return;
      raced = true;
      // The recording pipeline lands a write between our read and write.
      const c = callRow("call-active");
      c.metadata = { ...c.metadata, recording: { recording_id: "egress-2" } };
      c.updated_at = "t-recording";
    };
    const r = await call("post", "/calls/:id/spam", { id: "call-active" });
    expect(r.status).toBe(200);
    expect(raced).toBe(true);
    const c = callRow("call-active");
    expect(c.metadata.recording).toEqual({ recording_id: "egress-2" });
    expect(c.metadata.spam.marked_by).toBe(OPERATOR);
  });

  it("reads workspaceId from the body too", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-active", query: {}, body: { workspaceId: WS } });
    expect(r.status).toBe(200);
    expect(r.body.spam).toBe(true);
  });

  it("404 when the call is not in the workspace", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-elsewhere" });
    expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    expect(callRow("call-elsewhere").metadata).toEqual({});
  });

  it("403 wrong_entry_source for a chat call", async () => {
    const r = await call("post", "/calls/:id/spam", { id: "call-chat" });
    expect(r).toEqual({ status: 403, body: { error: "wrong_entry_source" } });
    expect(callRow("call-chat").metadata).toEqual({});
  });

  it("400 without a workspaceId", async () => {
    const r = await call("post", "/calls/:id/spam", { query: {} });
    expect(r).toEqual({ status: 400, body: { error: "workspaceId_required" } });
  });
});

describe("POST /calls/:id/not-spam", () => {
  it("removes metadata.spam and clears only the contact flag", async () => {
    await call("post", "/calls/:id/spam", { id: "call-active" });
    h.publishOperatorEvent.mockReset();

    const r = await call("post", "/calls/:id/not-spam", { id: "call-active" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, call_id: "call-active", contact_id: "contact-1", conversation_ids: [], spam: false,
    });
    const c = callRow("call-active");
    expect("spam" in c.metadata).toBe(false);
    expect(c.metadata.recording).toEqual({ recording_id: "egress-1" });
    expect(h.db.contacts.find((x) => x.id === "contact-1")).toMatchObject({
      is_spam: false, spam_marked_at: null, spam_marked_by: null,
    });
    // Sibling conversations stay flagged, same as conversation not-spam.
    expect(h.db.conversations.filter((x) => x.is_spam).map((x) => x.id)).toEqual(["conv-a", "conv-b"]);
    expect(h.publishOperatorEvent).not.toHaveBeenCalled();
    expect(h.db.call_events.at(-1)!.event_type).toBe("call_unmarked_spam");
  });

  it("404 / 403 like the spam route", async () => {
    expect((await call("post", "/calls/:id/not-spam", { id: "call-elsewhere" })).status).toBe(404);
    expect(await call("post", "/calls/:id/not-spam", { id: "call-chat" }))
      .toEqual({ status: 403, body: { error: "wrong_entry_source" } });
  });
});

describe("GET routes still expose metadata.spam", () => {
  it("GET /calls/:id and GET /calls return metadata", async () => {
    await call("post", "/calls/:id/spam", { id: "call-active" });
    const one = await call("get", "/calls/:id", { id: "call-active" });
    expect(one.body.call.metadata.spam.marked_by).toBe(OPERATOR);
    const list = await call("get", "/calls");
    const row = list.body.calls.find((x: Row) => x.id === "call-active");
    expect(row.metadata.spam.marked_by).toBe(OPERATOR);
  });
});

describe("markSpam / unmarkSpam (shared contact helper refactor)", () => {
  const config = { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" } as any;

  it("markSpam flags the contact and all their conversations", async () => {
    const r = await markSpam(config, { workspaceId: WS, conversationId: "conv-a", operatorId: OPERATOR });
    expect(r).toEqual({ ok: true, conversation_ids: ["conv-a", "conv-b"], contact_id: "contact-1" });
    expect(h.db.contacts.find((x) => x.id === "contact-1")).toMatchObject({ is_spam: true, spam_marked_by: OPERATOR });
    expect(h.db.conversations.filter((x) => x.is_spam).map((x) => x.id)).toEqual(["conv-a", "conv-b"]);
  });

  it("markSpam on an anonymous conversation flags only that thread", async () => {
    const r = await markSpam(config, { workspaceId: WS, conversationId: "conv-anon", operatorId: OPERATOR });
    expect(r).toEqual({ ok: true, conversation_ids: ["conv-anon"], contact_id: null });
    expect(h.db.conversations.filter((x) => x.is_spam).map((x) => x.id)).toEqual(["conv-anon"]);
  });

  it("unmarkSpam clears the conversation and contact, not siblings", async () => {
    await markSpam(config, { workspaceId: WS, conversationId: "conv-a", operatorId: OPERATOR });
    const r = await unmarkSpam(config, { workspaceId: WS, conversationId: "conv-a", operatorId: OPERATOR });
    expect(r).toEqual({ ok: true, conversation_ids: ["conv-a"], contact_id: "contact-1" });
    expect(h.db.contacts.find((x) => x.id === "contact-1")!.is_spam).toBe(false);
    expect(h.db.conversations.filter((x) => x.is_spam).map((x) => x.id)).toEqual(["conv-b"]);
  });

  it("throws conversation_not_found for a foreign conversation", async () => {
    await expect(markSpam(config, { workspaceId: OTHER_WS, conversationId: "conv-a", operatorId: OPERATOR }))
      .rejects.toThrow("conversation_not_found");
  });
});
