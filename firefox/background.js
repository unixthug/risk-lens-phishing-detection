/* ============================== RiskLens Background ============================== */

const DEFAULTS = {
  apiBaseUrl: "https://risklens-api-9e7l.onrender.com",
  blockingEnabled: true,
  /* Danger threshold is fixed — not user-configurable for safety */
  dangerThreshold: 70,
  cacheTtlMinutes: 10,
  bypassDurationMinutes: 60,
};

let settings = { ...DEFAULTS };

/* allowlistHosts: hostname -> expiresAtMs (0 = permanent) */
let allowlistHosts = {};

/* hostCache: hostname -> { score, label, verdict, explanations, raw, reason, error, updatedAtMs } */
let hostCache = {};

function now() {
  return Date.now();
}
function isHttpUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

async function saveHostCache() {
  await browser.storage.local.set({ hostCache });
}

async function saveAllowlist() {
  await browser.storage.local.set({ allowlistHosts });
}

function isAllowlisted(url) {
  const host = hostnameOf(url);
  if (!host) return false;

  const expiresAt = allowlistHosts[host];
  if (expiresAt == null) return false;
  if (expiresAt === 0) return true; /* permanent */

  if (typeof expiresAt === "number" && expiresAt > now()) return true;

  /* expired — clean up */
  delete allowlistHosts[host];
  saveAllowlist().catch(() => {});
  return false;
}

async function loadState() {
  const s = await browser.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s };

  /* dangerThreshold is locked — always use the default */
  settings.dangerThreshold = DEFAULTS.dangerThreshold;

  const a = await browser.storage.local.get({
    allowlistHosts: {},
    allowlist: {},
  });
  allowlistHosts = a.allowlistHosts || {};

  /* backward compat: migrate old exact-URL allowlist → hostname allowlist */
  if (
    !Object.keys(allowlistHosts).length &&
    a.allowlist &&
    typeof a.allowlist === "object"
  ) {
    for (const [url, exp] of Object.entries(a.allowlist)) {
      const h = hostnameOf(url);
      if (h) allowlistHosts[h] = exp;
    }
    await browser.storage.local.set({ allowlistHosts });
  }

  const c = await browser.storage.local.get({ hostCache: {} });
  hostCache = c.hostCache || {};
}

function scoreToLabel(score) {
  if (score == null) return "safe";
  const s = Number(score);
  if (!Number.isFinite(s)) return "safe";
  if (s >= 70) return "danger";
  if (s >= 40) return "suspicious";
  return "safe";
}

const ICONS = {
  safe: "icons/safe.png",
  suspicious: "icons/sus.png",
  danger: "icons/danger.png",
};

function pickTopReasons(raw) {
  if (!raw) return [];
  const reasons = raw.why_flagged || raw.reasons || raw.explanations;
  if (Array.isArray(reasons)) return reasons.slice(0, 5);

  /* If backend returns a dict of feature→importance, show top entries */
  if (reasons && typeof reasons === "object") {
    return Object.entries(reasons)
      .map(([k, v]) => ({ k, v: Number(v) }))
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5)
      .map((x) => `${x.k}: ${x.v}`);
  }

  return [];
}

/* ---------- React to settings changes from options page ---------- */

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.blockingEnabled)
    settings.blockingEnabled = !!changes.blockingEnabled.newValue;
  /* dangerThreshold is NOT user-changeable — ignored even if stored */
  if (changes.bypassDurationMinutes)
    settings.bypassDurationMinutes = Number(
      changes.bypassDurationMinutes.newValue
    );
  if (changes.cacheTtlMinutes)
    settings.cacheTtlMinutes = Number(changes.cacheTtlMinutes.newValue);

  if (changes.allowlistHosts)
    allowlistHosts = changes.allowlistHosts.newValue || {};
  if (changes.hostCache) hostCache = changes.hostCache.newValue || {};
});

function getCachedForHost(host) {
  const entry = hostCache[host];
  if (!entry) return null;

  const ttlMs = Number(settings.cacheTtlMinutes) * 60_000;
  if (
    typeof entry.updatedAtMs === "number" &&
    entry.updatedAtMs + ttlMs > now()
  )
    return entry;

  delete hostCache[host];
  saveHostCache().catch(() => {});
  return null;
}

/* ------------------------------ Model scoring ------------------------------ */

async function fetchModelScore(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { score: null, label: "safe", reason: "Invalid URL" };
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    return { score: null, label: "safe", reason: "Unsupported URL scheme" };
  }

  const apiBase = (settings.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(
    /\/+$/,
    ""
  );
  const endpoint = `${apiBase}/score`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlString }),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    if (!res.ok) {
      const msg =
        (data && (data.detail || data.error)) || `API error (${res.status})`;
      return { score: null, label: "safe", reason: msg, raw: data || text };
    }

    const prob = data?.prob_phishing;
    const score =
      data?.score != null
        ? Number(data.score)
        : Number.isFinite(Number(prob))
          ? Math.round(Number(prob) * 100)
          : null;

    const label = scoreToLabel(score);
    const verdict = data?.verdict || null;
    const explanations = pickTopReasons(data);

    return {
      score,
      label,
      verdict,
      explanations,
      reason: verdict ? `Model: ${verdict}` : "Model result",
      raw: data,
    };
  } catch (e) {
    return {
      score: null,
      label: "safe",
      reason: "Network error",
      error: String(e),
    };
  }
}

/* ------------------------------ Tab state ---------------------------------- */

async function setStateForTab(tabId, url) {
  const host = hostnameOf(url);
  if (!host) return;

  const cached = getCachedForHost(host);
  let hostEntry = cached;

  if (!cached) {
    const result = await fetchModelScore(url);
    hostEntry = {
      score: result.score,
      label: result.label,
      verdict: result.verdict,
      explanations: result.explanations || [],
      raw: result.raw || null,
      reason: result.reason || null,
      error: result.error || null,
      updatedAtMs: now(),
    };
    hostCache[host] = hostEntry;
    await saveHostCache();
  }

  const explanations =
    hostEntry.explanations && hostEntry.explanations.length
      ? hostEntry.explanations
      : pickTopReasons(hostEntry.raw);

  const tabEntry = hostEntry.error
    ? {
        tabId,
        url,
        score: null,
        label: "safe",
        reason: hostEntry.reason || "Error",
        error: hostEntry.error,
        raw: hostEntry.raw,
        explanations: [],
        updatedAt: now(),
      }
    : {
        tabId,
        url,
        score: hostEntry.score,
        label: hostEntry.label,
        verdict: hostEntry.verdict,
        reason: hostEntry.verdict
          ? `Model: ${hostEntry.verdict}`
          : "Model result",
        raw: hostEntry.raw,
        explanations,
        updatedAt: now(),
      };

  await browser.storage.local.set({ [`tab:${tabId}`]: tabEntry });

  await browser.browserAction.setIcon({
    tabId,
    path: ICONS[tabEntry.label] || ICONS.safe,
  });

  const title =
    tabEntry.score == null
      ? "RiskLens"
      : `RiskLens: ${tabEntry.score}/100 (${tabEntry.label})`;
  await browser.browserAction.setTitle({ tabId, title });
}

/* ---------- Navigation listeners ---------- */

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.url || !isHttpUrl(tab.url)) return;
  await setStateForTab(tabId, tab.url);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await browser.tabs.get(tabId);
  if (!tab?.url || !isHttpUrl(tab.url)) return;
  await setStateForTab(tabId, tab.url);
});

browser.tabs.onRemoved.addListener((tabId) => {
  browser.storage.local.remove(`tab:${tabId}`).catch(() => {});
});

/* -------------------- Warning page + allow bypass ---------------------- */

browser.runtime.onMessage.addListener(async (msg) => {
  /* Popup asks background to score the active tab immediately */
  if (msg?.type === "SCORE_TAB_NOW" && Number.isFinite(msg.tabId)) {
    const tab = await browser.tabs.get(msg.tabId);
    if (tab?.url && tab.id != null && isHttpUrl(tab.url)) {
      await setStateForTab(tab.id, tab.url);
    }
    return;
  }

  /* warning.html sends this when the user clicks "Continue Anyway" */
  if (msg?.type === "ALLOW_ONCE") {
    const targetUrl = typeof msg.url === "string" ? msg.url : "";
    const host =
      typeof msg.host === "string" ? msg.host : hostnameOf(targetUrl);
    if (!host) return;

    const minutes = Number(settings.bypassDurationMinutes);

    let expiresAt;
    if (!Number.isFinite(minutes) || minutes < 0) {
      expiresAt = now() + DEFAULTS.bypassDurationMinutes * 60_000;
    } else if (minutes === 0) {
      expiresAt = 0; /* permanent */
    } else {
      expiresAt = now() + minutes * 60_000;
    }

    allowlistHosts[host] = expiresAt;
    await saveAllowlist();
    return;
  }
});

/* ---------------------- Blocking / redirecting ------------------------- */

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (!settings.blockingEnabled) return {};
      if (details.type !== "main_frame") return {};

      const url = details.url;
      if (!isHttpUrl(url)) return {};

      const warningPrefix = browser.runtime.getURL("warning.html");
      if (url.startsWith(warningPrefix)) return {};

      if (isAllowlisted(url)) return {};

      const host = hostnameOf(url);
      if (!host) return {};

      const cached = getCachedForHost(host);
      if (!cached || cached.score == null) return {};

      const isDanger =
        Number(cached.score) >= Number(settings.dangerThreshold);
      if (!isDanger) return {};

      const redirect = browser.runtime.getURL(
        `warning.html?target=${encodeURIComponent(url)}&score=${encodeURIComponent(
          String(cached.score)
        )}&verdict=${encodeURIComponent(String(cached.verdict || ""))}`
      );

      return { redirectUrl: redirect };
    } catch {
      return {};
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

/* ------------------------------- Init -------------------------------- */

loadState().catch(() => {});
