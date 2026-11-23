/**
 * Inbox realtime — Layer 3 of the realtime stack.
 *
 * Two subscription groups:
 *
 * 1. `inbox:*` events → invalidate the inbox list AND the cross-workspace
 *    unread summary that backs the tab badge (the summary lives under its
 *    own account-level key, so the list invalidation does not reach it).
 *    The read/archive payloads carry only ids, so refetching is cheaper
 *    than maintaining per-event patchers. EXCEPTION `inbox:new`: its
 *    payload is the complete row, and a full list refetch per notification
 *    (~1.9MB) is what produced the 1–7.5s inbox tail — that one patches
 *    the cache locally via `applyInboxNewItem`, which falls back to the
 *    full refresh only when membership really changes (MULT-34).
 *    Multi-device parity:
 *    subscribing to inbox:read / inbox:archived means a read/archive on web
 *    reaches mobile within the next WS frame (web's use-realtime-sync
 *    deliberately DOESN'T subscribe to those, but mobile's stricter freshness
 *    wins for multi-device users).
 *
 * 2. `issue:*` events → patch the inbox cache directly via the dedicated
 *    updaters (inbox-ws-updaters.ts). Required because:
 *      - `issue:updated` with a new status must flip the inbox row's
 *        StatusIcon inline — otherwise the row keeps showing stale status.
 *      - `issue:deleted` must strip every inbox item pointing at that
 *        issue, otherwise tapping the orphan row 404s on issue/[id].
 *    Web does the same in `packages/core/inbox/ws-updaters.ts`.
 *
 * Reconnect: invalidate the list (we may have missed events while down;
 * no replay buffer in v1).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useWSSubscriptions } from "@/lib/use-ws-subscriptions";
import {
  applyInboxNewItem,
  dropInboxItemsByIssue,
  patchInboxIssueStatus,
  refreshInboxList,
  refreshInboxUnreadSummary,
} from "./inbox-ws-updaters";

export function useInboxRealtime() {
  const qc = useQueryClient();

  useWSSubscriptions(
    (ws, wsId) => {
      const invalidate = () => {
        // Shared entry points: each cancels an in-flight request before
        // invalidating, which a plain invalidate cannot do on a first load.
        // Both caches, because the badge is rendered over the list it counts.
        void refreshInboxList(qc, wsId);
        void refreshInboxUnreadSummary(qc);
      };

      return [
        // Inbox-domain events: refetch the inbox list and the badge count.
        // `inbox:new` is the exception — the payload carries the full row,
        // so it is patched into the cache instead of re-downloading ~1.9MB
        // per notification (MULT-34). The badge summary is a separate
        // small read and is refreshed either way.
        ws.on("inbox:new", (payload) => {
          void applyInboxNewItem(qc, wsId, payload.item);
          void refreshInboxUnreadSummary(qc);
        }),
        ws.on("inbox:read", invalidate),
        // Mobile has no mark-unread affordance yet (web/desktop right-click
        // only), but a mark-unread there must un-read the row here too —
        // otherwise the phone keeps showing it read and the unread dots
        // disagree across clients.
        ws.on("inbox:unread", invalidate),
        ws.on("inbox:archived", invalidate),
        // Mobile has no archived view yet (web/desktop only, MUL-3736), but an
        // unarchive there restores the item to THIS list — without refetching,
        // mobile keeps showing the pre-restore list.
        ws.on("inbox:unarchived", invalidate),
        ws.on("inbox:batch-read", invalidate),
        ws.on("inbox:batch-archived", invalidate),

        // Cross-cutting: issue events that need to patch inbox state.
        ws.on("issue:updated", (payload) => {
          patchInboxIssueStatus(
            qc,
            wsId,
            payload.issue.id,
            payload.issue.status,
          );
        }),
        ws.on("issue:deleted", (payload) => {
          void dropInboxItemsByIssue(qc, wsId, payload.issue_id);
        }),

        // After a reconnect we don't know what we missed during the
        // downtime — refresh from server.
        ws.onReconnect(invalidate),
      ];
    },
    [qc],
  );
}
