/**
 * Verify the session in .env still works, and exercise every account tool.
 *
 *   npm run check:auth
 *
 * Stops at the first 401 rather than hammering the account with failed auth.
 */
import { WillhabenClient, WillhabenError } from "../src/http.ts";
import { getActiveAlertCount, getProfile, getWatchlist, listConversations } from "../src/account.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // Fall through to the explicit check below.
}

const cookie = process.env.WILLHABEN_COOKIE;
if (!cookie) {
  console.error("No WILLHABEN_COOKIE. Run: npm run session -- <path-to.har>");
  process.exit(1);
}

const client = new WillhabenClient({ cookie, minIntervalMs: 600 });

function fail(err: unknown): never {
  if (err instanceof WillhabenError && (err.status === 401 || err.status === 403)) {
    console.error(
      `\nFAIL  session rejected (${err.status}).\n` +
        "The captured session is no longer valid. Re-export a HAR from a logged-in\n" +
        "browser and run: npm run session -- <path-to.har>",
    );
    process.exit(1);
  }
  console.error("\nFAIL ", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Profile first: it is the cheapest call and the one that proves the session.
let userId: string | null = null;
try {
  const profile = await getProfile(client);
  userId = profile.userId;
  console.log(`PASS  profile — ${profile.nickname ?? "(no nickname)"} / id=${profile.userId}`);
} catch (err) {
  fail(err);
}

try {
  const alerts = await getActiveAlertCount(client);
  console.log(`PASS  alert count — ${alerts} active saved searches`);
} catch (err) {
  fail(err);
}

try {
  const conversations = await listConversations(client, 5);
  console.log(`PASS  conversations — ${conversations.length} returned`);
  const first = conversations[0];
  if (first) console.log(`        latest: ${first.adTitle ?? "(no title)"} / unread=${first.unread}`);
} catch (err) {
  fail(err);
}

if (userId) {
  try {
    const watchlist = await getWatchlist(client, userId);
    console.log(`PASS  watchlist — ${watchlist.length} saved ads`);
    const first = watchlist[0];
    if (first) console.log(`        e.g. €${first.price} ${first.title.slice(0, 55)}`);
  } catch (err) {
    fail(err);
  }
} else {
  console.log("SKIP  watchlist — profile returned no numeric user id");
}

console.log("\nAll account tools verified.");
