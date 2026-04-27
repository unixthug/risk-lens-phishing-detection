const DEFAULTS = {
  blockingEnabled: true,
  bypassDurationMinutes: 60,
};

async function load() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  document.getElementById("blockingEnabled").checked = !!cfg.blockingEnabled;
  document.getElementById("bypassDuration").value = String(
    cfg.bypassDurationMinutes
  );
}

async function save() {
  const blockingEnabled = document.getElementById("blockingEnabled").checked;
  const bypassDurationMinutes = Number(
    document.getElementById("bypassDuration").value
  );

  await browser.storage.local.set({
    blockingEnabled,
    bypassDurationMinutes: Number.isFinite(bypassDurationMinutes)
      ? bypassDurationMinutes
      : DEFAULTS.bypassDurationMinutes,
  });

  const status = document.getElementById("status");
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 1500);
}

document.getElementById("saveBtn").addEventListener("click", save);

(async () => {
  /* ── Apply theme from shared storage ── */
  const theme = await browser.storage.local.get({ popupLightMode: false });
  if (theme.popupLightMode) document.body.classList.add("light-mode");

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.popupLightMode) return;
    document.body.classList.toggle("light-mode", !!changes.popupLightMode.newValue);
  });

  await load();
})();

async function resetApi() {
  const all = await browser.storage.local.get(null);
  const tabKeys = Object.keys(all).filter((k) => k.startsWith("tab:"));
  await browser.storage.local.remove([
    "apiBaseUrl",
    "hostCache",
    ...tabKeys,
  ]);

  const status = document.getElementById("resetStatus");
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 1500);
}

document.getElementById("resetApiBtn").addEventListener("click", resetApi);
