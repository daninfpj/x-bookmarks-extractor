# x-bookmarks

Fetches all your X bookmarks into a local SQLite database. Incremental — on subsequent runs it stops as soon as it hits a tweet already in the DB.

## Requirements

- [Bun](https://bun.sh)

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

### 3. Fetch bookmarks

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

## Files

| File | Purpose |
|---|---|
| `fetch-bookmarks.ts` | Main fetch + store script |
| `set-auth.ts` | Parses a copied curl command and writes `.env` |
| `bookmarks.db` | SQLite database (created on first run) |
| `.env` | Your credentials (never commit this) |
