/**
 * wallet-api — Cloudflare Worker backing the wallet app.
 *
 * Endpoints (all require the shared key):
 *   GET  /state  -> current wallet state
 *   POST /log    -> {amount, category, note?} append entry, return state
 *   POST /reset  -> append RESET row, return state
 *
 * The GitHub token lives here (env.GITHUB_TOKEN), never on the phone.
 * Balance is derived purely from spending_log.csv: $rate lands at each
 * midnight (America/New_York) since the last RESET row, the reset day
 * itself included; logged spending subtracts.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Wallet-Key",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const key = request.headers.get("X-Wallet-Key") || url.searchParams.get("k");
    if (!env.WALLET_KEY || key !== env.WALLET_KEY) {
      return json({ error: "bad key" }, 401);
    }

    try {
      if (request.method === "GET" && url.pathname === "/state") {
        const { rows } = await readLog(env);
        return json(await stateFrom(rows, env));
      }
      if (request.method === "POST" && url.pathname === "/log") {
        const body = await request.json();
        const amount = Number(body.amount);
        const category = String(body.category || "").toUpperCase();
        const note = String(body.note || "").slice(0, 200);
        const config = await readConfig(env);
        const valid = config.categories.map((c) => c.id);
        if (!Number.isFinite(amount) || amount <= 0 || amount >= 100000) {
          return json({ error: "bad amount" }, 400);
        }
        if (!valid.includes(category)) {
          return json({ error: "bad category" }, 400);
        }
        const rows = await appendRow(env, {
          timestamp: nowIso(env),
          amount: amount.toFixed(2),
          category,
          note,
        }, `spending: $${amount.toFixed(2)} ${category}`);
        return json(await stateFrom(rows, env));
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        const rows = await appendRow(env, {
          timestamp: nowIso(env),
          amount: "0",
          category: "RESET",
          note: "",
        }, "wallet reset");
        return json(await stateFrom(rows, env));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------- GitHub contents API ----------

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "wallet-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGet(env, path) {
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/contents/${path}?ref=${env.BRANCH}`,
    { headers: ghHeaders(env) }
  );
  if (!res.ok) throw new Error(`github get ${path}: ${res.status}`);
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { content, sha: data.sha };
}

async function ghPut(env, path, content, sha, message) {
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: btoa(unescape(encodeURIComponent(content))),
        sha,
        branch: env.BRANCH,
      }),
    }
  );
  if (!res.ok) throw new Error(`github put ${path}: ${res.status}`);
}

async function readLog(env) {
  const { content, sha } = await ghGet(env, env.LOG_PATH);
  return { rows: parseCsv(content), sha, content };
}

let configCache = { at: 0, value: null };
async function readConfig(env) {
  if (configCache.value && Date.now() - configCache.at < 60_000) {
    return configCache.value;
  }
  const { content } = await ghGet(env, env.CONFIG_PATH);
  configCache = { at: Date.now(), value: JSON.parse(content) };
  return configCache.value;
}

async function appendRow(env, row, message, retry = true) {
  const { rows, sha, content } = await readLog(env);
  const line = [row.timestamp, row.amount, row.category, csvEscape(row.note)].join(",");
  const next = content.endsWith("\n") ? content + line + "\n" : content + "\n" + line + "\n";
  try {
    await ghPut(env, env.LOG_PATH, next, sha, message);
  } catch (err) {
    // one retry on sha conflict
    if (retry && String(err).includes("409")) {
      return appendRow(env, row, message, false);
    }
    throw err;
  }
  rows.push(row);
  return rows;
}

// ---------- CSV ----------

function csvEscape(s) {
  if (s == null || s === "") return "";
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 3) continue;
    rows.push({
      timestamp: cols[0],
      amount: cols[1],
      category: cols[2],
      note: cols[3] || "",
    });
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- time (America/New_York) ----------

function tzDateParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return p;
}

function nowIso(env) {
  const now = new Date();
  const p = tzDateParts(now, env.TZ);
  const offsetMin = -tzOffsetMinutes(now, env.TZ);
  const sign = offsetMin <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}

function tzOffsetMinutes(date, tz) {
  const p = tzDateParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Calendar date (days since epoch) of a timestamp, in the wallet timezone. */
function calDay(tsOrDate, tz) {
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  const p = tzDateParts(d, tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

// ---------- wallet state ----------

async function stateFrom(rows, env) {
  const config = await readConfig(env);
  const rate = Number(config.daily_rate);
  const tz = env.TZ;
  const now = new Date();

  let resetIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].category === "RESET") { resetIdx = i; break; }
  }
  const resetTs = resetIdx >= 0 ? rows[resetIdx].timestamp
    : rows.length > 0 ? rows[0].timestamp : null;

  // Accrual: reset day itself earns its $rate, +$rate each midnight after.
  const accruedDays = resetTs ? calDay(now, tz) - calDay(resetTs, tz) + 1 : 1;

  const live = rows.slice(resetIdx + 1).filter((r) => r.category !== "RESET");
  const spent = live.reduce((s, r) => s + Number(r.amount), 0);
  const balance = accruedDays * rate - spent;

  const today = calDay(now, tz);
  const todayEntries = live
    .filter((r) => calDay(r.timestamp, tz) === today)
    .map((r) => ({
      time: r.timestamp, amount: Number(r.amount),
      category: r.category, note: r.note,
    }));
  const todaySpent = todayEntries.reduce((s, e) => s + e.amount, 0);

  let recoveryDate = null;
  if (balance < 0) {
    const daysNeeded = Math.ceil(-balance / rate);
    const rec = new Date(now.getTime() + daysNeeded * 86400000);
    const p = tzDateParts(rec, tz);
    recoveryDate = `${p.year}-${p.month}-${p.day}`;
  }

  return {
    balance: round2(balance),
    rate,
    today_spent: round2(todaySpent),
    today_entries: todayEntries,
    recovery_date: recoveryDate,
    last_reset: resetTs,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
