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

load();
