import { Database } from "bun:sqlite";

// ── Database ──────────────────────────────────────────────────────────────────

const DB_PATH = "./bookmarks.db";

let db: Database;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch {
  console.error("Could not open bookmarks.db. Run 'bun run fetch' first.");
  process.exit(1);
}

// ── API helpers ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function getStats() {
  const total = (db.query("SELECT COUNT(*) as n FROM bookmarks").get() as any).n;
  const summarized = (
    db
      .query(
        "SELECT COUNT(*) as n FROM bookmarks WHERE link_summary IS NOT NULL AND link_summary != ''"
      )
      .get() as any
  ).n;
  const oldest = (
    db.query("SELECT MIN(tweet_created_at) as d FROM bookmarks").get() as any
  ).d;
  const newest = (
    db.query("SELECT MAX(tweet_created_at) as d FROM bookmarks").get() as any
  ).d;
  return { total, summarized, oldest, newest };
}

function getBookmarks(q: string, filter: string, offset: number) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    conditions.push(
      "(text LIKE ? OR author_name LIKE ? OR author_screen_name LIKE ? OR link_summary LIKE ?)"
    );
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  if (filter === "summarized") {
    conditions.push("link_summary IS NOT NULL AND link_summary != ''");
  } else if (filter === "unsummarized") {
    conditions.push("(link_summary IS NULL OR link_summary = '')");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT tweet_id, text, author_name, author_screen_name,
           tweet_created_at, link_summary
    FROM bookmarks
    ${where}
    ORDER BY rowid ASC
    LIMIT ${PAGE_SIZE} OFFSET ?
  `;
  params.push(offset);

  const countSql = `SELECT COUNT(*) as n FROM bookmarks ${where}`;
  const total = (db.query(countSql).all(...params.slice(0, -1)) as any)[0].n;
  const rows = db.query(sql).all(...params);

  return { rows, total };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>X Bookmarks</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:          #09090b;
      --surface:     #18181b;
      --surface2:    #1f1f23;
      --border:      #27272a;
      --text:        #fafafa;
      --muted:       #a1a1aa;
      --accent:      #60a5fa;
      --accent-dim:  #1e3a5f;
      --summary-bg:  #0d1b2a;
      --summary-border: #1e3a5f;
      --tag-bg:      #27272a;
      --radius:      12px;
      --radius-sm:   8px;
    }

    html { font-size: 15px; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      line-height: 1.6;
    }

    /* ── Header ── */
    header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(9,9,11,0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
    }

    .header-inner {
      max-width: 1280px;
      margin: 0 auto;
      height: 56px;
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 1.05rem;
      letter-spacing: -0.02em;
      flex-shrink: 0;
    }

    .brand svg { width: 20px; height: 20px; fill: var(--text); }

    .stats-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-left: auto;
      font-size: 0.8rem;
      color: var(--muted);
    }

    .stat { display: flex; align-items: center; gap: 5px; }
    .stat-val { color: var(--text); font-weight: 600; }

    /* ── Main layout ── */
    main {
      max-width: 1280px;
      margin: 0 auto;
      padding: 28px 24px 60px;
    }

    /* ── Toolbar ── */
    .toolbar {
      display: flex;
      gap: 12px;
      margin-bottom: 28px;
      align-items: center;
      flex-wrap: wrap;
    }

    .search-wrap {
      flex: 1;
      min-width: 220px;
      position: relative;
    }

    .search-wrap svg {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      width: 16px;
      height: 16px;
      fill: none;
      stroke: var(--muted);
      stroke-width: 2;
      pointer-events: none;
    }

    #search {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-size: 0.9rem;
      padding: 9px 14px 9px 38px;
      outline: none;
      transition: border-color 0.15s;
    }

    #search::placeholder { color: var(--muted); }
    #search:focus { border-color: var(--accent); }

    .filters {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }

    .filter-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: var(--radius-sm);
      font-size: 0.82rem;
      padding: 8px 14px;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }

    .filter-btn:hover { border-color: var(--muted); color: var(--text); }

    .filter-btn.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }

    /* ── Result count ── */
    .result-info {
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 20px;
    }

    /* ── Grid ── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 16px;
    }

    /* ── Card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: border-color 0.15s, transform 0.15s;
    }

    .card:hover {
      border-color: #3f3f46;
      transform: translateY(-1px);
    }

    /* Card header */
    .card-header {
      display: flex;
      align-items: flex-start;
      gap: 11px;
    }

    .avatar {
      flex-shrink: 0;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #fff;
    }

    .author-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .author-name {
      font-weight: 600;
      font-size: 0.9rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .author-handle {
      font-size: 0.8rem;
      color: var(--muted);
    }

    .tweet-date {
      flex-shrink: 0;
      font-size: 0.75rem;
      color: var(--muted);
      margin-top: 2px;
    }

    /* Tweet text */
    .tweet-text {
      font-size: 0.9rem;
      line-height: 1.65;
      color: #e4e4e7;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tweet-text.truncated {
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .expand-btn {
      background: none;
      border: none;
      color: var(--accent);
      font-size: 0.8rem;
      cursor: pointer;
      padding: 0;
      margin-top: -8px;
    }

    .expand-btn:hover { text-decoration: underline; }

    /* Summary */
    .summary-section {
      background: var(--summary-bg);
      border: 1px solid var(--summary-border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .summary-label {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
    }

    .summary-text {
      font-size: 0.85rem;
      color: #cbd5e1;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Footer */
    .card-footer {
      margin-top: auto;
      padding-top: 4px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }

    .open-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.78rem;
      color: var(--muted);
      text-decoration: none;
      padding: 4px 8px;
      border-radius: 6px;
      transition: background 0.15s, color 0.15s;
    }

    .open-link:hover {
      background: var(--surface2);
      color: var(--text);
    }

    .open-link svg {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
    }

    /* ── Load more ── */
    .load-more-wrap {
      text-align: center;
      margin-top: 36px;
    }

    #load-more {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: var(--radius-sm);
      font-size: 0.88rem;
      padding: 10px 28px;
      cursor: pointer;
      transition: all 0.15s;
    }

    #load-more:hover { border-color: var(--muted); }
    #load-more:disabled { opacity: 0.4; cursor: default; }
    #load-more.hidden { display: none; }

    /* ── Empty state ── */
    .empty {
      text-align: center;
      padding: 80px 20px;
      color: var(--muted);
    }

    .empty-icon { font-size: 2.5rem; margin-bottom: 12px; }
    .empty-title { font-size: 1.05rem; font-weight: 600; color: var(--text); margin-bottom: 6px; }
    .empty-sub { font-size: 0.88rem; }

    /* ── Skeleton ── */
    .skeleton-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    @keyframes shimmer {
      0% { background-position: -600px 0; }
      100% { background-position: 600px 0; }
    }

    .skel {
      background: linear-gradient(90deg, #27272a 25%, #3f3f46 50%, #27272a 75%);
      background-size: 600px 100%;
      animation: shimmer 1.4s infinite;
      border-radius: 4px;
    }

    .skel-row { display: flex; align-items: center; gap: 10px; }
    .skel-avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; }
    .skel-lines { flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .skel-line { height: 10px; }
    .skel-w80 { width: 80%; }
    .skel-w60 { width: 60%; }
    .skel-w40 { width: 40%; }
    .skel-block { height: 60px; width: 100%; }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      header { padding: 0 16px; }
      main { padding: 20px 16px 60px; }
      .grid { grid-template-columns: 1fr; }
      .stats-bar { display: none; }
    }
  </style>
</head>
<body>

<header>
  <div class="header-inner">
    <div class="brand">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.631 5.905-5.631Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
      Bookmarks
    </div>
    <div class="stats-bar" id="stats-bar">
      <div class="stat">
        <span class="stat-val" id="stat-total">—</span>
        <span>saved</span>
      </div>
      <div class="stat">
        <span class="stat-val" id="stat-summarized">—</span>
        <span>summarized</span>
      </div>
    </div>
  </div>
</header>

<main>
  <div class="toolbar">
    <div class="search-wrap">
      <svg viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input id="search" type="search" placeholder="Search bookmarks…" autocomplete="off" />
    </div>
    <div class="filters">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="summarized">Summarized</button>
      <button class="filter-btn" data-filter="unsummarized">No summary</button>
    </div>
  </div>

  <div class="result-info" id="result-info"></div>
  <div class="grid" id="grid"></div>
  <div class="load-more-wrap">
    <button id="load-more" class="hidden">Load more</button>
  </div>
</main>

<script>
  // ── State ──────────────────────────────────────────────────────────────────
  let currentQ = '';
  let currentFilter = 'all';
  let offset = 0;
  let totalCount = 0;
  let loading = false;

  // ── Avatar colors ─────────────────────────────────────────────────────────
  const AVATAR_COLORS = [
    '#3b82f6','#8b5cf6','#ec4899','#f97316','#10b981',
    '#14b8a6','#f59e0b','#ef4444','#6366f1','#06b6d4',
  ];

  function avatarColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initials(name) {
    return name
      .split(/\\s+/)
      .slice(0, 2)
      .map(w => w[0] || '')
      .join('')
      .toUpperCase() || '?';
  }

  // ── Date formatting ───────────────────────────────────────────────────────
  function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Escape HTML ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ── Render card ───────────────────────────────────────────────────────────
  function renderCard(b) {
    const color = avatarColor(b.author_screen_name || b.author_name || b.tweet_id);
    const abbr  = initials(b.author_name || b.author_screen_name || '?');
    const url   = b.author_screen_name
      ? \`https://x.com/\${esc(b.author_screen_name)}/status/\${esc(b.tweet_id)}\`
      : '#';

    const text = b.text || '';
    const LIMIT = 400;
    const needsExpand = text.length > LIMIT;
    const displayText = needsExpand ? text.slice(0, LIMIT) + '…' : text;

    const summaryHtml = b.link_summary
      ? \`<div class="summary-section">
           <div class="summary-label">Summary</div>
           <div class="summary-text">\${esc(b.link_summary)}</div>
         </div>\`
      : '';

    return \`
      <article class="card">
        <div class="card-header">
          <div class="avatar" style="background:\${color}">\${esc(abbr)}</div>
          <div class="author-info">
            <span class="author-name">\${esc(b.author_name || 'Unknown')}</span>
            <span class="author-handle">@\${esc(b.author_screen_name || '')}</span>
          </div>
          <time class="tweet-date">\${fmtDate(b.tweet_created_at)}</time>
        </div>

        <p class="tweet-text\${needsExpand ? ' truncated' : ''}">\${esc(text)}</p>
        \${needsExpand ? \`<button class="expand-btn" onclick="toggleExpand(this)">Show more</button>\` : ''}

        \${summaryHtml}

        <div class="card-footer">
          <a class="open-link" href="\${url}" target="_blank" rel="noopener">
            Open on X
            <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>
      </article>
    \`;
  }

  function toggleExpand(btn) {
    const p = btn.previousElementSibling;
    const expanded = !p.classList.contains('truncated');
    if (expanded) {
      p.classList.add('truncated');
      btn.textContent = 'Show more';
    } else {
      p.classList.remove('truncated');
      btn.textContent = 'Show less';
    }
  }

  // ── Skeleton ──────────────────────────────────────────────────────────────
  function renderSkeletons(n = 6) {
    return Array.from({ length: n }, () => \`
      <div class="skeleton-card">
        <div class="skel-row">
          <div class="skel skel-avatar"></div>
          <div class="skel-lines">
            <div class="skel skel-line skel-w80"></div>
            <div class="skel skel-line skel-w60"></div>
          </div>
          <div class="skel skel-line skel-w40" style="height:10px;width:60px;flex-shrink:0"></div>
        </div>
        <div class="skel skel-block"></div>
      </div>
    \`).join('');
  }

  // ── Fetch data ────────────────────────────────────────────────────────────
  async function fetchBookmarks(reset = false) {
    if (loading) return;
    loading = true;

    if (reset) {
      offset = 0;
      document.getElementById('grid').innerHTML = renderSkeletons();
      document.getElementById('load-more').classList.add('hidden');
      document.getElementById('result-info').textContent = '';
    }

    const params = new URLSearchParams({ q: currentQ, filter: currentFilter, offset });
    const res = await fetch(\`/api/bookmarks?\${params}\`);
    const { rows, total } = await res.json();

    totalCount = total;

    const grid = document.getElementById('grid');

    if (reset) grid.innerHTML = '';

    if (rows.length === 0 && reset) {
      grid.innerHTML = \`
        <div class="empty" style="grid-column:1/-1">
          <div class="empty-icon">🔖</div>
          <div class="empty-title">No bookmarks found</div>
          <div class="empty-sub">Try a different search or filter</div>
        </div>
      \`;
    } else {
      grid.insertAdjacentHTML('beforeend', rows.map(renderCard).join(''));
    }

    offset += rows.length;

    // Result info
    const info = document.getElementById('result-info');
    if (currentQ || currentFilter !== 'all') {
      info.textContent = \`\${total} result\${total !== 1 ? 's' : ''}\`;
    } else {
      info.textContent = '';
    }

    // Load more button
    const btn = document.getElementById('load-more');
    if (offset < total) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = \`Load more (\${total - offset} remaining)\`;
    } else {
      btn.classList.add('hidden');
    }

    loading = false;
  }

  async function loadStats() {
    const res = await fetch('/api/stats');
    const s = await res.json();
    document.getElementById('stat-total').textContent = s.total.toLocaleString();
    document.getElementById('stat-summarized').textContent = s.summarized.toLocaleString();
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  let debounceTimer;
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentQ = e.target.value.trim();
      fetchBookmarks(true);
    }, 280);
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      fetchBookmarks(true);
    });
  });

  document.getElementById('load-more').addEventListener('click', () => {
    document.getElementById('load-more').disabled = true;
    fetchBookmarks(false);
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  loadStats();
  fetchBookmarks(true);
</script>
</body>
</html>`;

// ── Server ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000");

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/stats") {
      return Response.json(getStats());
    }

    if (url.pathname === "/api/bookmarks") {
      const q = url.searchParams.get("q") ?? "";
      const filter = url.searchParams.get("filter") ?? "all";
      const offset = parseInt(url.searchParams.get("offset") ?? "0");
      return Response.json(getBookmarks(q, filter, offset));
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`\n  X Bookmarks Visualizer`);
console.log(`  Open → http://localhost:${PORT}\n`);
