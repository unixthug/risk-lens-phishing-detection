/* ========================= RiskLens Popup ========================= */

/* ── Helpers ── */

function safeHostname(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url || "";
  }
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

/* ── Color mapping based on score ── */

function scoreColor(score) {
  if (score == null || !Number.isFinite(Number(score))) {
    return { stroke: "var(--muted)", cls: "" };
  }
  const s = Number(score);
  if (s >= 70) return { stroke: "var(--red)", cls: "danger" };
  if (s >= 40) return { stroke: "var(--amber)", cls: "suspicious" };
  return { stroke: "var(--green)", cls: "safe" };
}

/* ── Ring progress ── */

function setRingProgress(score) {
  const ring = document.getElementById("ringFill");
  const r = 72;
  const C = 2 * Math.PI * r;
  const { stroke } = scoreColor(score);

  ring.style.stroke = stroke;

  if (score == null || !Number.isFinite(Number(score))) {
    ring.style.strokeDasharray = `0 ${C}`;
    return;
  }

  const s = Math.max(0, Math.min(100, Number(score)));
  const filled = (s / 100) * C;
  ring.style.strokeDasharray = `${filled} ${C}`;
}

/* ── Score text color ── */

function setScoreColor(score) {
  const el = document.getElementById("score");
  const { stroke } = scoreColor(score);
  el.style.color = stroke;
}

/* ── Verdict badge ── */

function setVerdictBadge(label, score) {
  const badge = document.getElementById("verdictBadge");
  const labelEl = document.getElementById("verdictLabel");
  const { cls } = scoreColor(score);

  badge.className = "verdict-badge";
  if (cls) badge.classList.add(cls);

  if (score != null && Number.isFinite(Number(score))) {
    labelEl.textContent = `${(label || "unknown").toUpperCase()} · ${Math.round(score)}/100`;
  } else {
    labelEl.textContent = label ? label.toUpperCase() : "SCANNING…";
  }
}

/* ── Reasons list ── */

function renderReasons(entry) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";

  const reasons =
    (Array.isArray(entry?.explanations) && entry.explanations.length > 0)
      ? entry.explanations
      : Array.isArray(entry?.raw?.why_flagged)
        ? entry.raw.why_flagged
        : Array.isArray(entry?.raw?.reasons)
          ? entry.raw.reasons
          : Array.isArray(entry?.raw?.explanations)
            ? entry.raw.explanations
            : [];

  if (!reasons.length) {
    const li = document.createElement("li");
    li.className = "noReasons";
    li.textContent = "No flags detected.";
    list.replaceWith(li.cloneNode(true));

    /* Re-insert the <ul> hidden */
    const placeholder = document.createElement("span");
    placeholder.className = "noReasons";
    placeholder.textContent = "No flags detected.";
    list.parentNode?.insertBefore(placeholder, list);
    list.style.display = "none";
    return;
  }

  list.style.display = "";
  /* Remove any previous "no flags" spans */
  list.parentNode?.querySelectorAll(".noReasons").forEach((el) => el.remove());

  for (const r of reasons.slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = String(r);
    list.appendChild(li);
  }
}

/* ── Raw JSON ── */

function renderRaw(entry) {
  const box = document.getElementById("rawJson");
  const raw = entry?.raw ?? {};

  if (typeof raw === "string") {
    box.textContent = raw;
    return;
  }
  try {
    box.textContent = JSON.stringify(raw, null, 2);
  } catch {
    box.textContent = String(raw);
  }
}

/* ── Detail fields ── */

function setAdvancedFields(entry) {
  const verdict = entry?.raw?.verdict ?? entry?.verdict ?? "—";
  const prob = entry?.raw?.prob_phishing ?? entry?.prob_phishing ?? "—";
  const score = entry?.score;

  document.getElementById("verdict").textContent =
    verdict == null ? "—" : String(verdict);
  document.getElementById("prob").textContent =
    prob == null ? "—" : String(prob);
  document.getElementById("scoreDetail").textContent =
    score != null && Number.isFinite(Number(score))
      ? `${Math.round(Number(score))} / 100`
      : "—";

  renderReasons(entry);
  renderRaw(entry);
}

/* ── Main loader ── */

async function loadScore() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const key = `tab:${tab.id}`;
  const data = await browser.storage.local.get(key);
  const entry = data[key];

  const url = entry?.url || tab.url || "";
  const hostEl = document.getElementById("host");
  hostEl.textContent = url ? safeHostname(url) : "—";
  hostEl.title = url || "";

  if (!entry) {
    document.getElementById("score").textContent = "--";
    setRingProgress(null);
    setScoreColor(null);
    setVerdictBadge(null, null);

    document.getElementById("verdict").textContent = "—";
    document.getElementById("prob").textContent = "—";
    document.getElementById("scoreDetail").textContent = "—";
    document.getElementById("reasons").innerHTML = "";
    document.getElementById("rawJson").textContent = "{}";

    /* Ask background to score now */
    await browser.runtime.sendMessage({ type: "SCORE_TAB_NOW", tabId: tab.id });
    return;
  }

  const score = entry.score != null ? Number(entry.score) : null;

  document.getElementById("score").textContent =
    score != null && Number.isFinite(score) ? `${Math.round(score)}` : "--";

  const label = entry.label ? String(entry.label) : "unknown";

  setRingProgress(score);
  setScoreColor(score);
  setVerdictBadge(label, score);
  setAdvancedFields(entry);
}

/* ── Button handlers ── */

document.getElementById("settingsBtn").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
});

document.getElementById("siteBtn").addEventListener("click", async () => {
  await browser.tabs.create({
    url: "https://eli-69.github.io/Risklens.github.io/",
  });
});

document.getElementById("darkModeBtn").addEventListener("click", async () => {
  const isLight = document.body.classList.toggle("light-mode");
  await browser.storage.local.set({ popupLightMode: isLight });
});

/* ── Details toggle ── */

document.getElementById("advToggle").addEventListener("click", async () => {
  const panel = document.getElementById("advPanel");
  const btn = document.getElementById("advToggle");

  const open = panel.classList.toggle("open");
  btn.setAttribute("aria-expanded", open ? "true" : "false");

  const chev = btn.querySelector(".chev");
  if (chev) chev.textContent = open ? "▴" : "▾";

  await browser.storage.local.set({ popupAdvancedOpen: open });
});

/* ── Init ── */

(async () => {
  const saved = await browser.storage.local.get({
    popupLightMode: false,
    popupAdvancedOpen: false,
  });

  if (saved.popupLightMode) document.body.classList.add("light-mode");
  if (saved.popupAdvancedOpen) {
    document.getElementById("advPanel").classList.add("open");
    const btn = document.getElementById("advToggle");
    btn.setAttribute("aria-expanded", "true");
    const chev = btn.querySelector(".chev");
    if (chev) chev.textContent = "▴";
  }

  await loadScore();

  /* Live updates while popup is open */
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.keys(changes).some((k) => k.startsWith("tab:"))) {
      loadScore().catch(() => {});
    }
  });
})();
