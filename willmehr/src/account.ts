/**
 * Account-scoped endpoints — watchlist, chats, saved searches.
 *
 * These need the cookies of a logged-in browser session. willhaben authenticates
 * through Keycloak with PKCE, so there is no practical username/password grant
 * to automate; instead the session is lifted from a browser once and refreshed
 * when it expires. `x-bbx-csrf-token` is a per-session value the web app mirrors
 * from a cookie and sends on every /webapi/ call.
 */

import { ORIGIN, type WillhabenClient } from "./http.js";
import { normalizeListing } from "./normalize.js";
import type { Listing, RawAdvertSummary } from "./types.js";

export interface Profile {
  userId: string | null;
  nickname: string | null;
  email: string | null;
  memberSince: string | null;
}

export async function getProfile(client: WillhabenClient): Promise<Profile> {
  const raw = await client.getJson<Record<string, unknown>>(
    `${ORIGIN}/webapi/userprofile-service/userprofile/me`,
    { auth: true },
  );
  return {
    userId: str(raw.uuid) ?? str(raw.id),
    nickname: str(raw.nickname) ?? str(raw.name),
    email: str(raw.email),
    memberSince: str(raw.registerDate) ?? str(raw.createdDate),
  };
}

/**
 * The saved-ads folder. `userId` is the numeric account id, which appears in the
 * profile response — not the UUID.
 */
export async function getWatchlist(
  client: WillhabenClient,
  userId: string,
): Promise<Listing[]> {
  const raw = await client.getJson<{
    advertSummaryList?: { advertSummary?: RawAdvertSummary[] };
    userFolder?: Array<{ advertSummaryList?: { advertSummary?: RawAdvertSummary[] } }>;
  }>(`${ORIGIN}/webapi/iad/userfolders/all/${encodeURIComponent(userId)}`, { auth: true });

  const summaries = [
    ...(raw.advertSummaryList?.advertSummary ?? []),
    ...(raw.userFolder ?? []).flatMap((folder) => folder.advertSummaryList?.advertSummary ?? []),
  ];
  return summaries.map(normalizeListing);
}

export interface Conversation {
  id: string;
  adId: string | null;
  adTitle: string | null;
  counterparty: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unread: boolean;
}

export async function listConversations(
  client: WillhabenClient,
  limit = 20,
): Promise<Conversation[]> {
  const raw = await client.getJson<{ conversations?: RawConversation[]; data?: RawConversation[] }>(
    `${ORIGIN}/webapi/chat-api/v1/conversations?limit=${limit}&offset=0`,
    { auth: true },
  );

  const conversations = raw.conversations ?? raw.data ?? [];
  return conversations.map((conversation) => ({
    id: String(conversation.id ?? conversation.conversationId ?? ""),
    adId: conversation.adId ? String(conversation.adId) : null,
    adTitle: str(conversation.adTitle) ?? str(conversation.title),
    counterparty: str(conversation.partnerName) ?? str(conversation.counterpartyName),
    lastMessage: str(conversation.lastMessage?.text) ?? str(conversation.lastMessageText),
    lastMessageAt: str(conversation.lastMessage?.createdAt) ?? str(conversation.lastMessageDate),
    unread: Boolean(conversation.unreadCount ?? conversation.unread),
  }));
}

interface RawConversation {
  id?: string | number;
  conversationId?: string | number;
  adId?: string | number;
  adTitle?: unknown;
  title?: unknown;
  partnerName?: unknown;
  counterpartyName?: unknown;
  lastMessage?: { text?: unknown; createdAt?: unknown };
  lastMessageText?: unknown;
  lastMessageDate?: unknown;
  unreadCount?: number;
  unread?: boolean;
}

/** Number of saved searches with alerts enabled. */
export async function getActiveAlertCount(client: WillhabenClient): Promise<number> {
  const raw = await client.getJson<number | { count?: number }>(
    `${ORIGIN}/webapi/ad-search/alert/user/activeCount`,
    { auth: true },
  );
  return typeof raw === "number" ? raw : (raw.count ?? 0);
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
