/**
 * Mobile inbox cache patchers. Mirrors `packages/core/inbox/ws-updaters.ts`
 * (per CLAUDE.md "Mobile-owned updaters" — copy the design, don't import:
 * key factory binding + cache shape can drift independently).
 *
 * Two cross-cutting events that change inbox state without firing an
 * `inbox:*` event:
 *   - `issue:updated` carrying a new status → the inbox row's StatusIcon
 *     must update inline. Without this patch the row keeps showing the
 *     prior status until the next inbox event triggers a full refetch.
 *   - `issue:deleted` → all inbox items pointing at that issue are gone
 *     server-side (FK ON DELETE CASCADE in the DB); the cache should drop
 *     them too, otherwise tapping an inbox row navigates to a 404 issue.
 *
 * Listing-level only; use-inbox-realtime wires these into the WS layer.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { InboxItem, IssueStatus } from "@multica/core/types";
import { inboxKeys } from "@/data/queries/inbox";

export function patchInboxIssueStatus(
  qc: QueryClient,
  wsId: string,
  issueId: string,
  status: IssueStatus,
) {
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) =>
    old?.map((i) =>
      i.issue_id === issueId ? { ...i, issue_status: status } : i,
    ),
  );
}

/**
 * Re-read a query because the server changed, in a way a request already on
 * the wire cannot answer. Mirrors `refreshInboxQuery` in
 * packages/core/inbox/ws-updaters.ts — including why the cancel comes first.
 *
 * TanStack only cancels an in-flight request on invalidation once the query
 * already holds data (`Query.fetch` guards that branch on
 * `state.data !== undefined`, and otherwise returns the in-flight promise). A
 * change during a query's FIRST load is therefore answered by the pre-change
 * response, which resolves successfully and clears `isInvalidated`, with
 * nothing scheduled to ask again. Cancelling first makes a refresh behave the
 * same whether or not the query has loaded yet (MUL-6967).
 *
 * Both inbox caches go through this, not only the badge: the tab badge and the
 * list it counts are separate reads, so a hole in either one surfaces as the
 * badge disagreeing with the rows on screen.
 */
async function refreshInboxQuery(qc: QueryClient, queryKey: QueryKey) {
  await qc.cancelQueries({ queryKey });
  await qc.invalidateQueries({ queryKey });
}

/**
 * THE entry point for refreshing the workspace inbox list. Inbox events,
 * mutations and reconnect all go through here. The list's first load is not
 * a one-off: the inbox tab is mounted lazily, so the first visit loads it
 * while notifications keep arriving.
 */
export async function refreshInboxList(qc: QueryClient, wsId: string) {
  await refreshInboxQuery(qc, inboxKeys.list(wsId));
}

/**
 * Fold one `inbox:new` row into the cached list instead of re-downloading
 * the whole thing (MULT-34). The payload carries the complete InboxItem, so
 * for the common case a local patch shows the notification just as fast as a
 * refetch — while a full `GET /api/inbox` per notification (~1.9MB, ~1,000
 * rows) is exactly what produced the 1–7.5s tail. Mirrors the patch-vs-
 * invalidate split that `patchInboxIssueStatus` already applies to issue
 * events (packages/core/inbox/ws-updaters.ts `patchInboxLists` is the
 * web-side design this mirrors).
 *
 * Falls back to the full refresh when a patch cannot reproduce the server's
 * answer:
 *   - A list request that started BEFORE the event answers it without the
 *     new row, and its response would land on top of any patch. That
 *     request is already wasted — re-read. This also covers the first-load
 *     hole (MUL-6967): a change during the list's first load must not be
 *     answered by the pre-change response.
 *   - The active/archived split is server-owned: a notification on an issue
 *     whose rows sit archived revives those rows into the main list, and an
 *     archived row belongs to the archived view. Neither is reproducible by
 *     inserting one row (MUL-7286 keeps the same reasoning for issue
 *     events).
 *
 * The unread badge is a separate server-side summary — the caller refreshes
 * it regardless; this only touches the list cache.
 */
export async function applyInboxNewItem(
  qc: QueryClient,
  wsId: string,
  item: InboxItem,
): Promise<void> {
  const listKey = inboxKeys.list(wsId);
  const state = qc.getQueryState(listKey);

  if (state && state.fetchStatus !== "idle") {
    await refreshInboxList(qc, wsId);
    return;
  }

  const cached = state?.data as InboxItem[] | undefined;
  const archivedRows = qc.getQueryData<InboxItem[]>(inboxKeys.archived(wsId));
  const crossesArchivedBoundary =
    item.archived ||
    (item.issue_id != null &&
      (archivedRows?.some((i) => i.issue_id === item.issue_id) ||
        cached?.some((i) => i.archived && i.issue_id === item.issue_id)));
  if (crossesArchivedBoundary) {
    await refreshInboxList(qc, wsId);
    return;
  }

  // No cached list and nothing in flight: no observer to notify — the next
  // mount fetches the row with everything else.
  if (!cached) return;

  // Preserve an existing invalidation like core's patchInboxLists:
  // setQueryData clears `isInvalidated` even when the updater changes data,
  // and an inactive list must still refetch on its next mount (MUL-7286).
  const invalidated = state?.isInvalidated === true;
  qc.setQueryData<InboxItem[]>(listKey, (old) => {
    if (!old) return old;
    const existing = old.findIndex((i) => i.id === item.id);
    if (existing === -1) return [item, ...old];
    // Same row re-delivered (reconnect replay, duplicate frame): replace in
    // place instead of stacking a duplicate.
    if (old[existing] === item) return old;
    const next = [...old];
    next[existing] = item;
    return next;
  });
  if (invalidated) {
    void qc.invalidateQueries({
      queryKey: listKey,
      exact: true,
      refetchType: "none",
    });
  }
}

/**
 * THE entry point for refreshing the cross-workspace unread summary that backs
 * the tab badge. Mutations, inbox events, issue deletion and reconnect all go
 * through here. Mirrors `onInboxSummaryInvalidate` in
 * packages/core/inbox/ws-updaters.ts.
 */
export async function refreshInboxUnreadSummary(qc: QueryClient) {
  await refreshInboxQuery(qc, inboxKeys.unreadSummary());
}

// Dropping unread rows changes the tab badge, which reads the server-side
// unread summary rather than this list. `issue:deleted` fires no `inbox:*`
// event, so nothing else would refresh it and the badge would stay above an
// empty inbox — hence the refresh lives here, not at the call site.
// Web does the same in packages/core/inbox/ws-updaters.ts (MUL-6967).
export async function dropInboxItemsByIssue(
  qc: QueryClient,
  wsId: string,
  issueId: string,
) {
  qc.setQueryData<InboxItem[]>(inboxKeys.list(wsId), (old) =>
    old?.filter((i) => i.issue_id !== issueId),
  );
  await refreshInboxUnreadSummary(qc);
}
