/* checking.js — RiskLens scoring interstitial */

(async () => {
  function qp(name) {
    return new URL(location.href).searchParams.get(name);
  }

  /* ── Apply light/dark mode from shared storage preference ── */
  const theme = await chrome.storage.local.get({ popupLightMode: false });
  if (theme.popupLightMode) document.body.classList.add("light-mode");

  /* Stay in sync if the user toggles while this page is open */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.popupLightMode) return;
    document.body.classList.toggle("light-mode", !!changes.popupLightMode.newValue);
  });

  const target = qp("target") || "";

  const urlDisplay = document.getElementById("urlDisplay");
  try {
    urlDisplay.textContent = new URL(target).hostname || target;
  } catch {
    urlDisplay.textContent = target;
  }

  if (!target) {
    location.replace("about:blank");
    return;
  }

  /* Ask the background to score this URL immediately */
  await chrome.runtime.sendMessage({ type: "SCORE_URL_NOW", url: target });

  const POLL_INTERVAL_MS = 200;
  const TIMEOUT_MS = 15_000;
  const deadline = Date.now() + TIMEOUT_MS;

  let host = "";
  try {
    host = new URL(target).hostname;
  } catch {}

  async function poll() {
    const data = await chrome.storage.local.get({ hostCache: {} });
    const entry = (data.hostCache || {})[host];

    if (entry && typeof entry.score !== "undefined" && entry.score !== null) {
      const score = Number(entry.score);
      const dangerThreshold = 85; /* Must match background.js */

      if (Number.isFinite(score) && score >= dangerThreshold) {
        const warningUrl = chrome.runtime.getURL(
          `warning.html?target=${encodeURIComponent(target)}` +
          `&score=${encodeURIComponent(String(score))}` +
          `&verdict=${encodeURIComponent(String(entry.verdict || ""))}`
        );
        location.replace(warningUrl);
      } else {
        location.replace(target);
      }
      return;
    }

    if (Date.now() >= deadline) {
      location.replace(target);
      return;
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  }

  setTimeout(poll, POLL_INTERVAL_MS);
})();