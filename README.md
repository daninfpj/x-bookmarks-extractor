# x-bookmarks

Fetches all your X bookmarks into a local SQLite database. Incremental — on subsequent runs it stops as soon as it hits a tweet already in the DB.

## Requirements

- [Bun](https://bun.sh)
- [Claude Code CLI](https://claude.ai/code) — required for the link summarisation agent (`bun run summarize`)

## Setup

### 1. Get auth credentials from your browser

1. Go to [x.com/i/bookmarks](https://x.com/i/bookmarks) while logged in
2. Open DevTools → Network tab
3. Scroll your bookmarks to trigger a request
4. Click the `Bookmarks` request → **Request Headers**

You need:
| Env var | Where to find it |
|---|---|
| `X_BEARER_TOKEN` | `Authorization` header — strip the `Bearer ` prefix |
| `X_AUTH_TOKEN` | `Cookie` header — find `auth_token=<value>` |
| `X_CSRF_TOKEN` | `x-csrf-token` header |

### 2. Write your .env

The easiest way: right-click the Bookmarks request in DevTools → **Copy as cURL**, then:

```bash
pbpaste | bun set-auth.ts
```

This parses the curl command and writes `.env` automatically.

### 3. (Optional) Add your Anthropic API key

Required only for the link summarisation step. Get a key at [console.anthropic.com](https://console.anthropic.com) and add it to `.env`:

```
ANTHROPIC_API_KEY="sk-ant-..."
```

### 4. Fetch bookmarks

```bash
bun --env-file=.env run fetch-bookmarks.ts
```

## Usage

**First run** — fetches all bookmarks page by page (20 per page, 500ms between pages):

```
Fetching X bookmarks...

Page 1... 20 new
Page 2... 20 new
Page 3... 20 new
...
Done. 340 new bookmarks saved to bookmarks.db
Total in database: 340
```

**Subsequent runs** — fetches until it finds a bookmark already in the DB, then stops:

```
Fetching X bookmarks...

Page 1... 20 new
Page 2... 7 new — found existing, stopping.

Done. 27 new bookmarks saved to bookmarks.db
Total in database: 367
```

## Summarising bookmarks

After fetching, run the summarisation agent to enrich bookmarks that contain links or long-form content:

```bash
bun --env-file=.env run summarize
```

The agent classifies each bookmark and acts accordingly:

| Type | What happens |
|---|---|
| **External link** | The Claude Agent SDK fetches the linked article with its `WebFetch` tool and generates a bullet-point summary focused on actionable takeaways |
| **X article / note** | The long-form text is extracted from the tweet JSON and summarised directly |
| **Long tweet** | The tweet text itself (X Premium allows unlimited length) is summarised |
| **Simple tweet** | Skipped — no summary needed |

Summaries are stored in the `link_summary` column (see below). Already-processed bookmarks are skipped on subsequent runs.

Example output:

```
Processing 12 bookmarks...

[1/12] @leeerob — external_link
    ↳ Fetching: https://nextjs.org/blog/next-15
  → Summarised (8 bullets)

[2/12] @dan_abramov — simple
  → Simple tweet, skipping

[3/12] @swyx — x_article
  → Summarised (5 bullets)

Done. 8 summarised, 4 skipped (simple or inaccessible).
```

## Database

Bookmarks are stored in `bookmarks.db` (SQLite):

```sql
SELECT tweet_id, author_screen_name, text, tweet_created_at FROM bookmarks;
```

| Column | Description |
|---|---|
| `tweet_id` | Primary key |
| `text` | Full tweet text |
| `author_id` | Numeric user ID |
| `author_name` | Display name |
| `author_screen_name` | @handle |
| `tweet_created_at` | When the tweet was posted |
| `fetched_at` | When it was saved to the DB |
| `raw_json` | Full API response for the tweet |
| `link_summary` | Bullet-point summary of linked content (added by `bun run summarize`); empty string = processed but no summary; NULL = not yet processed |

## Files

| File | Purpose |
|---|---|
| `fetch-bookmarks.ts` | Main fetch + store script |
| `summarize-bookmarks.ts` | Claude Agent SDK script that summarises linked content |
| `set-auth.ts` | Parses a copied curl command and writes `.env` |
| `bookmarks.db` | SQLite database (created on first run) |
| `.env` | Your credentials (never commit this) |
