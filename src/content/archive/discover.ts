/**
 * Popup-facing conversation discovery for the "Import history" backfill
 * flow (see `src/popup/app.ts`).
 *
 * The popup cannot reach a platform's cookie-authenticated API directly —
 * `fetch(..., {credentials: 'include'})` only carries session cookies when
 * executed from a page on that origin — and it cannot import from
 * `content/` either (ADR-012, enforced by test/arch/layering.test.ts). So
 * discovery is driven from the popup over `chrome.tabs.sendMessage`, and
 * this module is the content-script side of that channel: one message in,
 * one full backfill-ready payload per conversation out.
 *
 * Limited to the platforms that actually have an `ArchiveAdapter` today
 * (Claude, ChatGPT); every other supported platform reports "unsupported"
 * rather than silently returning an empty list.
 */
import type { AIPlatform, ArchiveDiscoverResponse, ChatBackfillRequest } from '../../lib/types';
import { platformForHost } from '../../lib/platform-registry';
import { extractErrorMessage } from '../../lib/error-utils';
import type { ArchiveAdapter } from './types';
import { ClaudeArchiveAdapter } from './claude';
import { ChatGptArchiveAdapter } from './chatgpt';
import { toBackfillRequest } from './to-request';

const ARCHIVE_ADAPTER_CONSTRUCTORS: Partial<Record<AIPlatform, new () => ArchiveAdapter>> = {
  claude: ClaudeArchiveAdapter,
  chatgpt: ChatGptArchiveAdapter,
};

/**
 * Resolves the current tab's platform to its `ArchiveAdapter`, or throws
 * naming the calling action (e.g. "Import history", "Repair") in the
 * message — both callers below need the identical "no adapter for this
 * platform" guard, just with a different action name in the error.
 */
function resolveAdapter(action: string): ArchiveAdapter {
  const platform = platformForHost(window.location.hostname);
  const Adapter = platform ? ARCHIVE_ADAPTER_CONSTRUCTORS[platform] : undefined;
  if (!Adapter) {
    throw new Error(`${action} is not supported on ${window.location.hostname}`);
  }
  return new Adapter();
}

/**
 * Fetches every conversation the current session can see and converts each
 * one to a ready-to-send backfill payload. Throws (never returns a partial
 * list) on any adapter failure, matching the adapters' own
 * fail-loudly-rather-than-report-a-truncated-backfill-as-success posture.
 */
export async function discoverConversations(): Promise<ChatBackfillRequest[]> {
  const adapter = resolveAdapter('Import history');
  const entries = await adapter.listConversations();
  const conversations: ChatBackfillRequest[] = [];
  for (const entry of entries) {
    const conversation = await adapter.fetchConversation(entry);
    conversations.push(toBackfillRequest(conversation));
  }
  return conversations;
}

/**
 * Fetches and converts a single conversation by id — the content-script
 * side of the icon menu's "Repair this conversation from source" action
 * (`src/content/bootstrap.ts`), as opposed to `discoverConversations()`'s
 * whole-history sweep for the popup's bulk "Import history" flow.
 *
 * Still lists first, same as `discoverConversations()`: Claude's
 * `fetchConversation()` requires the `accountId` that `listConversations()`
 * tagged the entry with (an org cannot be safely guessed at — see
 * `ClaudeArchiveAdapter`), and ChatGPT's listing carries the title
 * `fetchConversation()` doesn't otherwise have.
 */
export async function fetchConversationForRepair(
  conversationId: string
): Promise<ChatBackfillRequest> {
  const adapter = resolveAdapter('Repair');
  const entries = await adapter.listConversations();
  const entry = entries.find(candidate => candidate.conversationId === conversationId);
  if (!entry) {
    throw new Error(
      `Conversation ${conversationId} was not found in ${adapter.platform} history`
    );
  }

  const conversation = await adapter.fetchConversation(entry);
  return toBackfillRequest(conversation);
}

/**
 * Registers the content-script side of the popup's discovery request.
 * Mirrors the offscreen document's sender check (`src/offscreen/offscreen.ts`):
 * only messages from another extension context (the popup) are honoured,
 * never another tab's content script re-broadcasting the same action name.
 */
export function registerArchiveDiscoveryListener(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: ArchiveDiscoverResponse) => void
    ) => {
      if (sender.id !== chrome.runtime.id || sender.tab !== undefined) {
        return false;
      }
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as { action?: unknown }).action !== 'archiveDiscover'
      ) {
        return false;
      }

      discoverConversations()
        .then(conversations => sendResponse({ success: true, conversations }))
        .catch((error: unknown) =>
          sendResponse({ success: false, error: extractErrorMessage(error) })
        );
      return true; // keep the message channel open for the async sendResponse above
    }
  );
}
