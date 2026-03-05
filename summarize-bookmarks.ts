import { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Bookmark {
  tweet_id: string;
  text: string;
  author_name: string;
  author_screen_name: string;
  raw_json: string;
}

interface TcoUrl {
  url: string;
  expanded_url: string;
  display_url: string;
}

type BookmarkType = "external_link" | "x_article" | "long_tweet" | "simple";

// ── Client ────────────────────────────────────────────────────────────────────

// Default to Sonnet — fast, cheap, great quality for summarisation.
// Override with --model claude-opus-4-6 for highest quality.
const DEFAULT_MODEL = "claude-sonnet-4-6";

const anthropic = new Anthropic();

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database("bookmarks.db");

// Add link_summary column if it doesn't exist yet
try {
  db.run("ALTER TABLE bookmarks ADD COLUMN link_summary TEXT");
  console.log("✓ Added link_summary column to bookmarks table\n");
} catch {
  // Column already exists — that's fine
}

// ── URL / content helpers ─────────────────────────────────────────────────────

const X_DOMAINS = new Set(["x.com", "twitter.com", "t.co", "pic.twitter.com"]);

function isXDomain(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      X_DOMAINS.has(hostname) ||
      hostname.endsWith(".x.com") ||
      hostname.endsWith(".twitter.com")
    );
  } catch {
    return false;
  }
}

/** Pull the expanded URLs out of tweet entities, keeping only external ones. */
function getExternalUrls(rawJson: string): string[] {
  try {
    const tweet = JSON.parse(rawJson);
    const urls: TcoUrl[] = tweet?.legacy?.entities?.urls ?? [];
    return urls
      .map((u) => u.expanded_url)
      .filter((url) => url && !isXDomain(url));
  } catch {
    return [];
  }
}

/**
 * X Notes / long-form articles store full text in note_tweet.
 * Returns the note body when it exists and is long enough to be worth
 * summarising.
 */
function getNoteContent(rawJson: string): string | null {
  try {
    const tweet = JSON.parse(rawJson);
    const text: string | undefined =
      tweet?.note_tweet?.note_tweet_results?.result?.text;
    if (text && text.length > 200) return text;
    return null;
  } catch {
    return null;
  }
}

// ── Classification ────────────────────────────────────────────────────────────

function classifyBookmark(bookmark: Bookmark): {
  type: BookmarkType;
  externalUrls: string[];
  noteContent: string | null;
} {
  // 1. X Note / long-form article
  const noteContent = getNoteContent(bookmark.raw_json);
  if (noteContent) {
    return { type: "x_article", externalUrls: [], noteContent };
  }

  // 2. Contains links to external sites
  const externalUrls = getExternalUrls(bookmark.raw_json);
  if (externalUrls.length > 0) {
    return { type: "external_link", externalUrls, noteContent: null };
  }

  // 3. Long tweet (X Premium allows unlimited characters)
  // Strip embedded t.co links before measuring — they don't add content.
  const textWithoutUrls = bookmark.text.replace(/https?:\/\/\S+/g, "").trim();
  if (textWithoutUrls.length > 280) {
    return { type: "long_tweet", externalUrls: [], noteContent: null };
  }

  // 4. Simple short tweet — nothing to summarise
  return { type: "simple", externalUrls: [], noteContent: null };
}

// ── Summarisation helpers ─────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You summarise bookmarked content from X (Twitter).
Rules:
• Focus ONLY on actionable tips and takeaways the reader can apply immediately.
• Use bullet points (•) for everything — avoid prose paragraphs.
• Be concise and scannable; every bullet must add value.
• Do NOT include intros, outros, or meta-commentary.
• If the content is inaccessible, paywalled, or not worth summarising (e.g. just a photo/video with no text), reply with exactly: SKIP`;

/**
 * Fetch the URL server-side via the web_fetch tool and summarise it.
 * Uses the Anthropic API directly — no Claude CLI subprocess needed.
 */
async function summarizeExternalUrl(
  url: string,
  tweetText: string,
  model: string
): Promise<string | null> {
  console.log(`    ↳ Fetching: ${url}`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${SYSTEM_INSTRUCTION}

The bookmarked tweet says:
"${tweetText}"

Fetch the article at ${url} and return a bullet-point summary of its actionable takeaways.
Return ONLY the bullets, or SKIP.`,
    },
  ];

  // The web_fetch tool runs server-side — the API fetches the URL and feeds
  // the content to Claude automatically. We just loop on pause_turn in case
  // the server-side loop needs more than one iteration.
  for (let i = 0; i < 5; i++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      // @ts-ignore — web_fetch_20260209 may not yet be in the SDK types
      tools: [{ type: "web_fetch_20260209", name: "web_fetch" }],
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const text =
        response.content.find((b): b is Anthropic.TextBlock => b.type === "text")
          ?.text ?? "";
      const trimmed = text.trim();
      return !trimmed || trimmed === "SKIP" ? null : trimmed;
    }

    if (response.stop_reason === "pause_turn") {
      // Server-side loop hit its iteration limit — re-send to continue.
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    break; // unexpected stop reason
  }

  return null;
}

/** Summarise text-only content (X articles / long tweets). */
async function summarizeText(
  content: string,
  label: string,
  model: string
): Promise<string | null> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `${SYSTEM_INSTRUCTION}

Summarise this ${label}:

${content}

Return ONLY the bullet-point summary, or SKIP if there is nothing actionable.`,
      },
    ],
  });

  const text =
    response.content.find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text ?? "";
  const trimmed = text.trim();
  return !trimmed || trimmed === "SKIP" ? null : trimmed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY environment variable.");
    console.error("Add it to your .env file and re-run.");
    process.exit(1);
  }

  // Optional --limit N argument
  const limitArg = process.argv.indexOf("--limit");
  const limit =
    limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : null;
  if (limit !== null && (isNaN(limit) || limit < 1)) {
    console.error("--limit must be a positive integer.");
    process.exit(1);
  }

  // Optional --model <model-id> argument
  const modelArg = process.argv.indexOf("--model");
  const model = modelArg !== -1 ? process.argv[modelArg + 1] : DEFAULT_MODEL;

  const query =
    limit != null
      ? `SELECT tweet_id, text, author_name, author_screen_name, raw_json
         FROM bookmarks
         WHERE link_summary IS NULL
         ORDER BY fetched_at DESC
         LIMIT ${limit}`
      : `SELECT tweet_id, text, author_name, author_screen_name, raw_json
         FROM bookmarks
         WHERE link_summary IS NULL
         ORDER BY fetched_at DESC`;

  const bookmarks = db.query<Bookmark, []>(query).all();

  if (bookmarks.length === 0) {
    console.log("All bookmarks already have summaries. Nothing to do.");
    return;
  }

  console.log(
    `Processing ${bookmarks.length} bookmarks${limit != null ? ` (limit: ${limit})` : ""} with ${model}...\n`
  );

  let summarized = 0;
  let skipped = 0;

  for (let i = 0; i < bookmarks.length; i++) {
    const bookmark = bookmarks[i];
    const { type, externalUrls, noteContent } = classifyBookmark(bookmark);
    const label = `[${i + 1}/${bookmarks.length}] @${bookmark.author_screen_name}`;

    console.log(`${label} — ${type}`);

    // Simple tweets need no summary — mark as processed and move on
    if (type === "simple") {
      db.run("UPDATE bookmarks SET link_summary = '' WHERE tweet_id = ?", [
        bookmark.tweet_id,
      ]);
      console.log("  → Simple tweet, skipping\n");
      skipped++;
      continue;
    }

    let summary: string | null = null;

    try {
      switch (type) {
        case "x_article":
          summary = await summarizeText(noteContent!, "X article / note", model);
          break;

        case "long_tweet":
          summary = await summarizeText(bookmark.text, "long tweet", model);
          break;

        case "external_link":
          for (const url of externalUrls) {
            summary = await summarizeExternalUrl(url, bookmark.text, model);
            if (summary) break;
          }
          break;
      }
    } catch (err) {
      console.error(
        `  → Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (summary) {
      db.run(
        "UPDATE bookmarks SET link_summary = ? WHERE tweet_id = ?",
        [summary, bookmark.tweet_id]
      );
      console.log(`  → Summarised (${summary.split("\n").length} bullets)\n`);
      summarized++;
    } else {
      db.run("UPDATE bookmarks SET link_summary = '' WHERE tweet_id = ?", [
        bookmark.tweet_id,
      ]);
      console.log("  → No summary extracted, marked as processed\n");
      skipped++;
    }

    // Polite delay between API calls
    if (i < bookmarks.length - 1) await Bun.sleep(500);
  }

  console.log(
    `Done. ${summarized} summarised, ${skipped} skipped (simple or inaccessible).`
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
