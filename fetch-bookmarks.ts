import { Database } from "bun:sqlite";

// ── Config ────────────────────────────────────────────────────────────────────

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const AUTH_TOKEN = process.env.X_AUTH_TOKEN;
const CSRF_TOKEN = process.env.X_CSRF_TOKEN;

if (!BEARER_TOKEN || !AUTH_TOKEN || !CSRF_TOKEN) {
  console.error("Missing env vars. Copy .env.example to .env and fill it in.");
  console.error("Required: X_BEARER_TOKEN, X_AUTH_TOKEN, X_CSRF_TOKEN");
  process.exit(1);
}

const ENDPOINT =
  "https://x.com/i/api/graphql/nWdgTDcvkR3dPXFCVwvOsg/Bookmarks";

const FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database("bookmarks.db");

db.run(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    tweet_id          TEXT PRIMARY KEY,
    text              TEXT,
    author_id         TEXT,
    author_name       TEXT,
    author_screen_name TEXT,
    tweet_created_at  TEXT,
    fetched_at        TEXT DEFAULT (datetime('now')),
    raw_json          TEXT
  )
`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO bookmarks
    (tweet_id, text, author_id, author_name, author_screen_name, tweet_created_at, raw_json)
  VALUES
    ($tweet_id, $text, $author_id, $author_name, $author_screen_name, $tweet_created_at, $raw_json)
`);

const exists = db.prepare(
  "SELECT 1 FROM bookmarks WHERE tweet_id = ? LIMIT 1"
);

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function buildUrl(cursor?: string): string {
  const variables: Record<string, unknown> = {
    count: 20,
    includePromotedContent: true,
  };
  if (cursor) variables.cursor = cursor;

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
  });
  return `${ENDPOINT}?${params}`;
}

async function fetchPage(cursor?: string): Promise<{
  tweets: any[];
  nextCursor: string | null;
}> {
  const res = await fetch(buildUrl(cursor), {
    headers: {
      authorization: `Bearer ${BEARER_TOKEN}`,
      "x-csrf-token": CSRF_TOKEN!,
      cookie: `auth_token=${AUTH_TOKEN}; ct0=${CSRF_TOKEN}`,
      "content-type": "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();

  const instructions: any[] =
    json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];

  const tweets: any[] = [];
  let nextCursor: string | null = null;

  for (const instruction of instructions) {
    if (instruction.type === "TimelineAddEntries") {
      for (const entry of instruction.entries ?? []) {
        const entryId: string = entry.entryId ?? "";

        // Cursor bottom = next page
        if (entryId.startsWith("cursor-bottom")) {
          nextCursor = entry.content?.value ?? null;
          continue;
        }

        const result =
          entry.content?.itemContent?.tweet_results?.result;
        if (!result) continue;

        // Unwrap tombstones / tweet wrappers
        const tweet =
          result.__typename === "TweetWithVisibilityResults"
            ? result.tweet
            : result;

        if (!tweet?.legacy) continue;
        tweets.push(tweet);
      }
    }
  }

  return { tweets, nextCursor };
}

// ── Parse tweet ───────────────────────────────────────────────────────────────

function parseTweet(tweet: any) {
  const legacy = tweet.legacy;
  const user = tweet.core?.user_results?.result?.legacy;

  return {
    $tweet_id: legacy.id_str ?? tweet.rest_id,
    $text: legacy.full_text ?? legacy.text ?? "",
    $author_id: legacy.user_id_str ?? "",
    $author_name: user?.name ?? "",
    $author_screen_name: user?.screen_name ?? "",
    $tweet_created_at: legacy.created_at ?? "",
    $raw_json: JSON.stringify(tweet),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching X bookmarks...\n");

  let cursor: string | undefined;
  let totalNew = 0;
  let page = 0;

  while (true) {
    page++;
    process.stdout.write(`Page ${page}... `);

    const { tweets, nextCursor } = await fetchPage(cursor);

    if (tweets.length === 0) {
      console.log("no tweets returned, done.");
      break;
    }

    let newOnPage = 0;
    let hitExisting = false;

    for (const tweet of tweets) {
      const parsed = parseTweet(tweet);
      const alreadyExists = exists.get(parsed.$tweet_id);

      if (alreadyExists) {
        hitExisting = true;
        break;
      }

      insert.run(parsed);
      newOnPage++;
    }

    totalNew += newOnPage;
    console.log(
      `${newOnPage} new${hitExisting ? " — found existing, stopping." : ""}`
    );

    if (hitExisting || !nextCursor) break;

    cursor = nextCursor;

    // Be polite — small delay between pages
    await Bun.sleep(500);
  }

  console.log(`\nDone. ${totalNew} new bookmarks saved to bookmarks.db`);

  const total = (db.query("SELECT COUNT(*) as n FROM bookmarks").get() as any)
    .n;
  console.log(`Total in database: ${total}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
