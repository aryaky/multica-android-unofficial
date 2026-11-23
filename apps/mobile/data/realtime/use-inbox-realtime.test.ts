// @vitest-environment node
// Subscription-wiring test for the inbox realtime hook (MULT-34 review):
// the `inbox:new` entry must survive old-format frames that carry no row,
// and a well-formed frame must go through the local patch + badge refresh.
// Runs the hook's setup callback against a fake WSClient — no RN render,
// same lane as realtime-provider.test.ts.
import { QueryClient } from "@tanstack/react-query";
import type { InboxItem } from "@multica/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  qc: null as QueryClient | null,
  setup: undefined as
    | ((ws: never, wsId: string) => (() => void)[] | undefined)
    | undefined,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => shared.qc!,
}));
vi.mock("@/lib/use-ws-subscriptions", () => ({
  useWSSubscriptions: (setup: (ws: never, wsId: string) => (() => void)[] | undefined) => {
    shared.setup = setup;
  },
}));
// inboxKeys → data/queries/inbox → data/api pulls in the native fetch chain.
vi.mock("@/data/api", () => ({ api: {} }));

import { inboxKeys } from "@/data/queries/inbox";
import { useInboxRealtime } from "./use-inbox-realtime";

const wsId = "workspace-1";

function item(id: string, issueId: string | null): InboxItem {
  return {
    id,
    workspace_id: wsId,
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: issueId,
    title: "Issue title",
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: "2026-09-01T08:00:00Z",
    details: null,
  };
}

/** Mount the hook, run its subscription setup, and return the WS handlers. */
function subscribe(): Record<string, (payload: unknown) => void> {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const ws = {
    on: (type: string, handler: (payload: unknown) => void) => {
      handlers[type] = handler;
      return () => {};
    },
    onReconnect: (handler: () => void) => {
      handlers["reconnect"] = handler;
      return () => {};
    },
  };
  useInboxRealtime();
  shared.setup!(ws as never, wsId);
  return handlers;
}

describe("useInboxRealtime inbox:new wiring", () => {
  beforeEach(() => {
    shared.qc = new QueryClient();
    shared.setup = undefined;
  });

  it("ignores old-format frames without a row instead of throwing", () => {
    const qc = shared.qc!;
    const cancel = vi.spyOn(qc, "cancelQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);
    const handlers = subscribe();

    // Pre-InboxItem payload shapes: missing item entirely, or no payload.
    expect(() => handlers["inbox:new"]!({})).not.toThrow();
    expect(() => handlers["inbox:new"]!(undefined)).not.toThrow();

    expect(
      qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.map((i) => i.id),
    ).toEqual(["n1"]);
    expect(cancel).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("patches a well-formed row into the list and refreshes the badge", async () => {
    const qc = shared.qc!;
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);
    const handlers = subscribe();

    handlers["inbox:new"]!({ item: item("n2", "issue-b") });
    await vi.waitFor(() => {
      expect(
        qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.map((i) => i.id),
      ).toEqual(["n2", "n1"]);
    });

    // The unread badge summary is a separate small read — still refreshed
    // (after the cancel-await inside refreshInboxQuery, so give it a tick).
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: inboxKeys.unreadSummary(),
      });
    });
  });
});
