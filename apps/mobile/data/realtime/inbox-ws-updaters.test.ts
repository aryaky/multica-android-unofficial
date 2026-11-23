// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import type { InboxItem } from "@multica/core/types";
import { describe, expect, it, vi } from "vitest";

import { inboxKeys } from "@/data/queries/inbox";
import {
  applyInboxNewItem,
  dropInboxItemsByIssue,
  patchInboxIssueStatus,
  refreshInboxList,
  refreshInboxUnreadSummary,
} from "./inbox-ws-updaters";

// inbox-ws-updaters imports inboxKeys from data/queries/inbox, which
// transitively imports the native fetch client. Mock it so the Node test never
// loads RN modules — inboxKeys itself is a pure key factory (same reason
// chat-ws-updaters.test.ts does this).
vi.mock("@/data/api", () => ({ api: {} }));

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

describe("dropInboxItemsByIssue", () => {
  it("drops every row pointing at the deleted issue", async () => {
    const qc = new QueryClient();
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [
      item("n1", "issue-a"),
      item("n2", "issue-b"),
    ]);

    await dropInboxItemsByIssue(qc, wsId, "issue-a");

    expect(
      qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.map((i) => i.id),
    ).toEqual(["n2"]);
  });

  it("refreshes the unread summary the dropped rows can change", async () => {
    // Parity with web (packages/core/inbox/ws-updaters.ts). The tab badge
    // reads the server summary, and `issue:deleted` fires no `inbox:*` event,
    // so without this the badge stays lit over an emptied inbox (MUL-6967).
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);

    await dropInboxItemsByIssue(qc, wsId, "issue-a");

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: inboxKeys.unreadSummary(),
    });
  });
});

describe("refreshInboxUnreadSummary", () => {
  it("cancels an in-flight summary request BEFORE invalidating", async () => {
    // Parity with web. TanStack skips its own cancel on a FIRST fetch
    // (`Query.fetch` guards it on `state.data !== undefined`) and reuses the
    // request already on the wire, whose success clears `isInvalidated` — so
    // an invalidate alone can be answered by a pre-change response and never
    // asked again (MUL-6967).
    const qc = new QueryClient();
    const calls: string[] = [];
    vi.spyOn(qc, "cancelQueries").mockImplementation(async () => {
      calls.push("cancel");
    });
    vi.spyOn(qc, "invalidateQueries").mockImplementation(async () => {
      calls.push("invalidate");
    });

    await refreshInboxUnreadSummary(qc);

    expect(calls).toEqual(["cancel", "invalidate"]);
  });

  it("targets the summary key only, never a workspace inbox list", async () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");

    await refreshInboxUnreadSummary(qc);

    expect(cancel).toHaveBeenCalledWith({
      queryKey: inboxKeys.unreadSummary(),
    });
    expect(cancel).not.toHaveBeenCalledWith({ queryKey: inboxKeys.list(wsId) });
  });
});

describe("patchInboxIssueStatus", () => {
  it("updates the row's status without touching the badge", () => {
    // A status change moves no notification in or out of the unread set, so
    // it must NOT invalidate the summary — that would refetch on every
    // issue:updated frame.
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);

    patchInboxIssueStatus(qc, wsId, "issue-a", "done");

    expect(
      qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.[0]?.issue_status,
    ).toBe("done");
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("refreshInboxList", () => {
  it("cancels the in-flight list request BEFORE invalidating", async () => {
    // Parity with web. Without the cancel, a change during the list's first
    // load is answered by the pre-change request and never re-read — the tab
    // badge (already cancel-first) then counts rows the list does not show
    // (MUL-6967).
    const qc = new QueryClient();
    const calls: string[] = [];
    vi.spyOn(qc, "cancelQueries").mockImplementation(async () => {
      calls.push("cancel");
    });
    vi.spyOn(qc, "invalidateQueries").mockImplementation(async () => {
      calls.push("invalidate");
    });

    await refreshInboxList(qc, wsId);

    expect(calls).toEqual(["cancel", "invalidate"]);
  });

  it("targets this workspace's list, never the account-level summary", async () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");

    await refreshInboxList(qc, wsId);

    expect(cancel).toHaveBeenCalledWith({ queryKey: inboxKeys.list(wsId) });
    expect(cancel).not.toHaveBeenCalledWith({
      queryKey: inboxKeys.unreadSummary(),
    });
  });
});

describe("applyInboxNewItem", () => {
  // MULT-34: one full `GET /api/inbox` (~1.9MB) per notification is what
  // produced the 1–7.5s tail. The payload carries the complete row, so the
  // patch path must not touch the network at all.

  it("prepends the row to the cached list without any refetch", async () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);

    await applyInboxNewItem(qc, wsId, item("n2", "issue-b"));

    expect(
      qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.map((i) => i.id),
    ).toEqual(["n2", "n1"]);
    expect(cancel).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("replaces a re-delivered row in place instead of stacking a duplicate", async () => {
    const qc = new QueryClient();
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [
      item("n1", "issue-a"),
      item("n2", "issue-b"),
    ]);

    const reread = { ...item("n1", "issue-a"), read: true };
    await applyInboxNewItem(qc, wsId, reread);

    const rows = qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId));
    expect(rows?.map((i) => i.id)).toEqual(["n1", "n2"]);
    expect(rows?.[0]?.read).toBe(true);
  });

  it("refetches while a list request is in flight — its response would bury the patch", async () => {
    // The request started before the event, so its answer lacks the new row
    // and lands on top of any setQueryData. Covers the first-load hole too
    // (MUL-6967): a change during the FIRST load must not be answered by
    // the pre-change response.
    const qc = new QueryClient();
    void qc
      .fetchQuery({
        queryKey: inboxKeys.list(wsId),
        queryFn: () => new Promise<InboxItem[]>(() => {}),
      })
      .catch(() => {});
    expect(qc.getQueryState(inboxKeys.list(wsId))?.fetchStatus).toBe(
      "fetching",
    );
    const cancel = vi.spyOn(qc, "cancelQueries");

    await applyInboxNewItem(qc, wsId, item("n2", "issue-b"));

    expect(cancel).toHaveBeenCalledWith({ queryKey: inboxKeys.list(wsId) });
  });

  it("refetches when the row crosses the active/archived boundary", async () => {
    // The server owns the split: an archived row belongs to the archived
    // view, and a notification on an issue whose rows sit archived revives
    // those rows into the main list. Neither is reproducible by inserting
    // one row (MUL-7286 reasoning).
    const qc = new QueryClient();
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [
      { ...item("old", "issue-a"), archived: true },
    ]);
    const cancel = vi.spyOn(qc, "cancelQueries");

    // (a) the new row itself is archived
    await applyInboxNewItem(qc, wsId, {
      ...item("n2", "issue-b"),
      archived: true,
    });
    // (b) the new row revives an issue whose rows sit archived in the list
    await applyInboxNewItem(qc, wsId, item("n3", "issue-a"));

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(1, {
      queryKey: inboxKeys.list(wsId),
    });
    expect(
      qc.getQueryData<InboxItem[]>(inboxKeys.list(wsId))?.map((i) => i.id),
    ).toEqual(["old"]);
  });

  it("refetches when the loaded archived view holds the issue", async () => {
    const qc = new QueryClient();
    qc.setQueryData<InboxItem[]>(inboxKeys.archived(wsId), [
      { ...item("arch-1", "issue-a"), archived: true },
    ]);
    const cancel = vi.spyOn(qc, "cancelQueries");

    await applyInboxNewItem(qc, wsId, item("n2", "issue-a"));

    expect(cancel).toHaveBeenCalledWith({ queryKey: inboxKeys.list(wsId) });
  });

  it("does nothing when no list is cached and nothing is in flight", async () => {
    // No observer to notify — the next mount fetches the row with
    // everything else. A cancel+invalidate pair here would mark a query
    // nobody reads and fetch nothing.
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    await applyInboxNewItem(qc, wsId, item("n2", "issue-b"));

    expect(qc.getQueryData(inboxKeys.list(wsId))).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps an existing invalidation mark on the patched list", async () => {
    // setQueryData clears isInvalidated even when it changes data; an
    // inactive list must still refetch on its next mount (MUL-7286).
    const qc = new QueryClient();
    qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), [item("n1", "issue-a")]);
    await qc.invalidateQueries({
      queryKey: inboxKeys.list(wsId),
      refetchType: "none",
    });
    expect(qc.getQueryState(inboxKeys.list(wsId))?.isInvalidated).toBe(true);

    await applyInboxNewItem(qc, wsId, item("n2", "issue-b"));

    expect(qc.getQueryState(inboxKeys.list(wsId))?.isInvalidated).toBe(true);
  });
});
