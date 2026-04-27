function qp(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

(async () => {
  const theme = await chrome.storage.local.get({ popupLightMode: false });
  if (theme.popupLightMode) document.body.classList.add("light-mode");

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.popupLightMode) return;
    document.body.classList.toggle("light-mode", !!changes.popupLightMode.newValue);
  });
  const target = qp("target") || "";
  const score = qp("score");
  const verdict = qp("verdict");

  document.getElementById("target").textContent = target || "Unknown URL";
  document.getElementById("details").textContent =
    `Score: ${score ?? "?"}/100` + (verdict ? ` · Verdict: ${verdict}` : "");

  /* Sync checkbox with current blocking state */
  const cfg = await chrome.storage.local.get({ blockingEnabled: true });
  document.getElementById("disable").checked = !cfg.blockingEnabled;

  document.getElementById("disable").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ blockingEnabled: !e.target.checked });
  });

  document.getElementById("optionsBtn").addEventListener("click", async () => {
    if (chrome?.runtime?.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
    } else {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("options.html"),
      });
    }
  });

  document.getElementById("back").addEventListener("click", () => {
    history.length > 1 ? history.back() : (location.href = "about:blank");
  });

  document.getElementById("continue").addEventListener("click", async () => {
    let host = "";
    try {
      host = new URL(target).hostname;
    } catch {}
    await chrome.runtime.sendMessage({
      type: "ALLOW_ONCE",
      url: target,
      host,
    });
    location.replace(target);
  });
})();
