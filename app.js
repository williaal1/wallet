/**
 * Wallet V2 — client. All state lives server-side (Worker + CSV in repo).
 * The phone holds only the shared key (URL param, mirrored to localStorage
 * as a convenience — fully recoverable from the laptop if lost).
 */

let config = null;
let key = null;
let amountStr = "";
let selectedCat = null;

const $ = (id) => document.getElementById(id);

init();

async function init() {
  config = await (await fetch("config.json")).json();

  renderCategories();
  $("daily-target").textContent = `/ $${config.daily_rate.toFixed(2)} today`;
  $("date-display").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const urlKey = new URLSearchParams(location.search).get("k");
  if (urlKey) {
    key = urlKey;
    localStorage.setItem("wallet_key", urlKey);
  } else {
    key = localStorage.getItem("wallet_key");
  }

  if (!key) {
    $("setup-modal").classList.remove("hidden");
    $("save-key").addEventListener("click", () => {
      const v = $("key-input").value.trim();
      if (!v) return;
      key = v;
      localStorage.setItem("wallet_key", v);
      history.replaceState(null, "", `?k=${encodeURIComponent(v)}`);
      $("setup-modal").classList.add("hidden");
      $("app").classList.remove("hidden");
      refreshState();
    });
    return;
  }

  $("app").classList.remove("hidden");
  wireInputs();
  refreshState();
}

function api(path, opts = {}) {
  return fetch(`${config.worker_url}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Wallet-Key": key,
      ...(opts.headers || {}),
    },
  });
}

async function refreshState() {
  try {
    const res = await api("/state");
    if (!res.ok) throw new Error(`state ${res.status}`);
    renderState(await res.json());
  } catch (err) {
    $("wallet-amount").textContent = "—";
    $("daily-total").textContent = "—";
    $("entries-list").innerHTML = '<p class="empty-state">Can\'t reach the wallet — pull to refresh</p>';
    showStatus(`Couldn't load: ${err.message}`, "error");
  }
}

function renderState(s) {
  const bal = $("wallet-amount");
  bal.textContent = fmtMoney(s.balance);
  bal.classList.toggle("negative", s.balance < 0);
  bal.classList.toggle("low", s.balance >= 0 && s.balance < s.rate);

  const rec = $("wallet-recovery");
  if (s.recovery_date) {
    const d = new Date(`${s.recovery_date}T12:00:00`);
    rec.textContent = `back positive ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
    rec.classList.remove("hidden");
  } else {
    rec.classList.add("hidden");
  }

  const today = $("daily-total");
  today.textContent = fmtMoney(s.today_spent);
  today.classList.toggle("over", s.today_spent > s.rate);
  today.classList.toggle(
    "warning",
    s.today_spent > s.rate * 0.75 && s.today_spent <= s.rate
  );

  const list = $("entries-list");
  if (s.today_entries.length === 0) {
    list.innerHTML = '<p class="empty-state">Nothing logged today</p>';
  } else {
    list.innerHTML = s.today_entries
      .slice()
      .reverse()
      .map((e) => {
        const t = new Date(e.time).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit",
        });
        const label = catLabel(e.category);
        return `<div class="entry">
          <div class="entry-left">
            <span class="entry-cat">${label}</span>
            ${e.note ? `<span class="entry-note">${escapeHtml(e.note)}</span>` : ""}
          </div>
          <div style="text-align:right">
            <div class="entry-amount">$${e.amount.toFixed(2)}</div>
            <div class="entry-time">${t}</div>
          </div>
        </div>`;
      })
      .join("");
  }
}

function renderCategories() {
  const grid = $("category-grid");
  grid.innerHTML = config.categories
    .map(
      (c) =>
        `<button class="cat${c.id === "OTHER" ? " cat-wide" : ""}" data-cat="${c.id}">${c.label}</button>`
    )
    .join("");
  grid.querySelectorAll(".cat").forEach((btn) => {
    btn.addEventListener("click", () => {
      grid.querySelectorAll(".cat").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedCat = btn.dataset.cat;
      updateSubmit();
    });
  });
}

function wireInputs() {
  document.querySelectorAll(".num").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.val;
      if (v === "del") amountStr = amountStr.slice(0, -1);
      else if (v === ".") {
        if (!amountStr.includes(".")) amountStr = amountStr === "" ? "0." : amountStr + ".";
      } else {
        const [, dec] = amountStr.split(".");
        if (dec !== undefined && dec.length >= 2) return;
        if (amountStr.replace(".", "").length >= 6) return;
        amountStr += v;
      }
      $("amount-display").textContent = fmtMoney(parseAmount());
      updateSubmit();
    });
  });

  $("submit-btn").addEventListener("click", submit);

  $("reset-wallet").addEventListener("click", async () => {
    if (!confirm("Reset the wallet? Balance starts over from today.")) return;
    try {
      const res = await api("/reset", { method: "POST" });
      if (!res.ok) throw new Error(`reset ${res.status}`);
      renderState(await res.json());
      showStatus("Wallet reset — fresh start", "success");
    } catch (err) {
      showStatus(`Reset failed: ${err.message}`, "error");
    }
  });
}

function parseAmount() {
  const n = parseFloat(amountStr);
  return Number.isFinite(n) ? n : 0;
}

function updateSubmit() {
  $("submit-btn").disabled = !(parseAmount() > 0 && selectedCat);
}

async function submit() {
  const amount = parseAmount();
  const category = selectedCat;
  const note = $("note-input").value.trim();
  const btn = $("submit-btn");
  btn.disabled = true;
  btn.textContent = "Logging…";
  try {
    const res = await api("/log", {
      method: "POST",
      body: JSON.stringify({ amount, category, note }),
    });
    if (!res.ok) throw new Error(`log ${res.status}`);
    renderState(await res.json());
    showStatus(`✓ $${amount.toFixed(2)} ${catLabel(category)} logged`, "success");
    amountStr = "";
    selectedCat = null;
    $("amount-display").textContent = "$0.00";
    $("note-input").value = "";
    document.querySelectorAll(".cat").forEach((b) => b.classList.remove("selected"));
  } catch (err) {
    showStatus(`Failed: ${err.message} — entry kept, try again`, "error");
  } finally {
    btn.textContent = "Log";
    updateSubmit();
  }
}

function catLabel(id) {
  const c = config.categories.find((c) => c.id === id);
  return c ? c.label : id;
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function showStatus(msg, kind) {
  const el = $("status-msg");
  el.textContent = msg;
  el.className = kind;
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
