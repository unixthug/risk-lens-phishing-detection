/* ============================== RiskLens Background ============================== */

const DEFAULTS = {
  apiBaseUrl: "https://risklens-gw-2eqv4bws.uc.gateway.dev",
  apiKey: "AIzaSyCd8QKokSdoMt7oYBoulmYMftCNOKccr4Y",
  blockingEnabled: true,
  /* Danger threshold is fixed — not user-configurable for safety */
  dangerThreshold: 85,
  cacheTtlMinutes: 10,
  bypassDurationMinutes: 60,
};

/* Ignore payment hosts to prevent blocking critical functionality */
const PAYMENT_AUTH_HOSTS = new Set([
  "paypal.com",
  "checkout.paypal.com",
  "stripe.com",
  "checkout.stripe.com",
  "js.stripe.com",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "auth0.com",
  "okta.com",
]);

function isFastPathHost(host) {
  if (!host) return false;
  for (const domain of PAYMENT_AUTH_HOSTS) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  return false;
}

let settings = { ...DEFAULTS };

/* allowlistHosts: hostname -> expiresAtMs (0 = permanent) */
let allowlistHosts = {};

/* hostCache: hostname -> { score, label, verdict, explanations, raw, reason, error, updatedAtMs } */
let hostCache = {};

/* Service worker may be killed; track whether state is loaded for this run */
let stateLoaded = false;
let loadStatePromise = null;

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
  await chrome.storage.local.set({ hostCache });
}

async function saveAllowlist() {
  await chrome.storage.local.set({ allowlistHosts });
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
  const s = await chrome.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s };

  /* dangerThreshold is locked — always use the default */
  settings.dangerThreshold = DEFAULTS.dangerThreshold;

  const a = await chrome.storage.local.get({
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
    await chrome.storage.local.set({ allowlistHosts });
  }

  const c = await chrome.storage.local.get({ hostCache: {} });
  hostCache = c.hostCache || {};

  stateLoaded = true;
}

/* Service workers can be killed and restarted; ensure state is loaded
   before any handler reads from settings/allowlistHosts/hostCache. */
async function ensureLoaded() {
  if (stateLoaded) return;
  if (!loadStatePromise) {
    loadStatePromise = loadState().catch((e) => {
      stateLoaded = false;
      loadStatePromise = null;
      throw e;
    });
  }
  await loadStatePromise;
}

function scoreToLabel(score) {
  if (score == null) return "safe";
  const s = Number(score);
  if (!Number.isFinite(s)) return "safe";
  if (s >= 85) return "danger";
  if (s >= 65) return "suspicious";
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

chrome.storage.onChanged.addListener((changes, area) => {
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey || DEFAULTS.apiKey,
      },
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
  await ensureLoaded();

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

  await chrome.storage.local.set({ [`tab:${tabId}`]: tabEntry });

  await chrome.action.setIcon({
    tabId,
    path: ICONS[tabEntry.label] || ICONS.safe,
  });

  const title =
    tabEntry.score == null
      ? "RiskLens"
      : `RiskLens: ${tabEntry.score}/100 (${tabEntry.label})`;
  await chrome.action.setTitle({ tabId, title });
}

/* ------------------------- URL Scoring -------------------------- */

async function scoreUrlInBackground(urlString) {
  const host = hostnameOf(urlString);
  if (!host) return;
  if (getCachedForHost(host)) return;

  const result = await fetchModelScore(urlString);
  hostCache[host] = {
    score: result.score,
    label: result.label,
    verdict: result.verdict,
    explanations: result.explanations || [],
    raw: result.raw || null,
    reason: result.reason || null,
    error: result.error || null,
    updatedAtMs: now(),
  };
  await saveHostCache();
}

/* ---------- Navigation listeners ---------- */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({
      url: "https://risklens-ten.vercel.app/"
    });
  }
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  await ensureLoaded();

  const url = details.url;
  if (!url || !isHttpUrl(url)) return;

  // Don't intercept our own pages
  const extBase = chrome.runtime.getURL("");
  if (url.startsWith(extBase)) return;

  if (!settings.blockingEnabled) return;
  if (isAllowlisted(url)) return;

  const host = hostnameOf(url);
  if (!host || isFastPathHost(host)) return;

  const cached = getCachedForHost(host);

  if (!cached || cached.score == null) {
    // No cache → gate behind checking.html
    const checkUrl = chrome.runtime.getURL(
      `checking.html?target=${encodeURIComponent(url)}`
    );
    chrome.tabs.update(details.tabId, { url: checkUrl });
    return;
  }

  if (Number(cached.score) >= Number(settings.dangerThreshold)) {
    const warnUrl = chrome.runtime.getURL(
      `warning.html?target=${encodeURIComponent(url)}` +
      `&score=${encodeURIComponent(String(cached.score))}` +
      `&verdict=${encodeURIComponent(String(cached.verdict || ""))}`
    );
    chrome.tabs.update(details.tabId, { url: warnUrl });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isHttpUrl(tab.url)) return;
  await setStateForTab(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`tab:${tabId}`).catch(() => {});
});

/* -------------------- Warning page + allow bypass ---------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* Service worker message handlers must return true to keep the channel
     open for an async response, OR not call sendResponse at all. We use
     async IIFEs and return true so the worker stays alive until done. */

  if (msg?.type === "SCORE_TAB_NOW" && Number.isFinite(msg.tabId)) {
    (async () => {
      await ensureLoaded();
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        if (tab?.url && tab.id != null && isHttpUrl(tab.url)) {
          await setStateForTab(tab.id, tab.url);
        }
      } catch {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "ALLOW_ONCE") {
    (async () => {
      await ensureLoaded();
      const targetUrl = typeof msg.url === "string" ? msg.url : "";
      const host =
        typeof msg.host === "string" ? msg.host : hostnameOf(targetUrl);
      if (!host) {
        sendResponse({ ok: false });
        return;
      }

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
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "SCORE_URL_NOW" && typeof msg.url === "string") {
    (async () => {
      await ensureLoaded();
      await scoreUrlInBackground(msg.url);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

/* ------------------------------- Init -------------------------------- */

ensureLoaded().catch(() => {});
