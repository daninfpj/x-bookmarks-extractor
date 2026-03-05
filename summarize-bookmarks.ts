import { Database } from "bun:sqlite";
import { query } from "@anthropic-ai/claude-agent-sdk";

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
 * Use the Agent SDK (WebFetch tool) to fetch the URL, then summarise it.
 * Returns null when the content is inaccessible or not worth summarising.
 */
async function summarizeExternalUrl(
  url: string,
  tweetText: string
): Promise<string | null> {
  console.log(`    ↳ Fetching: ${url}`);

  const prompt = `${SYSTEM_INSTRUCTION}

The bookmarked tweet says:
"${tweetText}"

Fetch the article at ${url} and return a bullet-point summary of its actionable takeaways.
Return ONLY the bullets, or SKIP.`;

  let result = "";

  for await (const message of query({
    prompt,
    options: {
      allowedTools: ["WebFetch"],
      maxTurns: 5,
      model: "claude-opus-4-6",
    },
  })) {
    if ("result" in message) {
      result = message.result ?? "";
    }
  }

  const trimmed = result.trim();
  if (!trimmed || trimmed === "SKIP") return null;
  return trimmed;
}

/**
 * Summarise text-only content (X articles / long tweets) without needing
 * to fetch any URL.
 */
async function summarizeText(
  content: string,
  label: string
): Promise<string | null> {
  const prompt = `${SYSTEM_INSTRUCTION}

Summarise this ${label}:

${content}

Return ONLY the bullet-point summary, or SKIP if there is nothing actionable.`;

  let result = "";

  for await (const message of query({
    prompt,
    options: {
      allowedTools: [],
      maxTurns: 2,
      model: "claude-opus-4-6",
    },
  })) {
    if ("result" in message) {
      result = message.result ?? "";
    }
  }

  const trimmed = result.trim();
  if (!trimmed || trimmed === "SKIP") return null;
  return trimmed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY environment variable.");
    console.error("Add it to your .env file and re-run.");
    process.exit(1);
  }

  const bookmarks = db
    .query<Bookmark, []>(
      `SELECT tweet_id, text, author_name, author_screen_name, raw_json
       FROM bookmarks
       WHERE link_summary IS NULL
       ORDER BY fetched_at DESC`
    )
    .all();

  if (bookmarks.length === 0) {
    console.log("All bookmarks already have summaries. Nothing to do.");
    return;
  }

  console.log(`Processing ${bookmarks.length} bookmarks...\n`);

  let summarized = 0;
  let skipped = 0;

  for (let i = 0; i < bookmarks.length; i++) {
    const bookmark = bookmarks[i];
    const { type, externalUrls, noteContent } = classifyBookmark(bookmark);
    const label = `[${i + 1}/${bookmarks.length}] @${bookmark.author_screen_name}`;

    console.log(`${label} — ${type}`);

    // Simple tweets need no summary — mark as processed and move on
    if (type === "simple") {
      db.run(
        "UPDATE bookmarks SET link_summary = '' WHERE tweet_id = ?",
        [bookmark.tweet_id]
      );
      console.log("  → Simple tweet, skipping\n");
      skipped++;
      continue;
    }

    let summary: string | null = null;

    try {
      switch (type) {
        case "x_article":
          summary = await summarizeText(noteContent!, "X article / note");
          break;

        case "long_tweet":
          summary = await summarizeText(bookmark.text, "long tweet");
          break;

        case "external_link":
          for (const url of externalUrls) {
            summary = await summarizeExternalUrl(url, bookmark.text);
            if (summary) break; // Stop at the first URL that yields content
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
      // Processed but no usable summary (paywalled, image-only, etc.)
      db.run(
        "UPDATE bookmarks SET link_summary = '' WHERE tweet_id = ?",
        [bookmark.tweet_id]
      );
      console.log("  → No summary extracted, marked as processed\n");
      skipped++;
    }

    // Polite delay between API calls
    if (i < bookmarks.length - 1) await Bun.sleep(1000);
  }

  console.log(
    `Done. ${summarized} summarised, ${skipped} skipped (simple or inaccessible).`
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
