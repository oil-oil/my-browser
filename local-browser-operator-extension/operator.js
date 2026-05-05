const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");

function renderStatus(status) {
  const rows = [
    `Polling: ${status.polling ? "yes" : "no"}`,
    `Client ID: ${status.clientId || "-"}`,
    `Attached tab: ${status.attachedTabId || "-"}`,
    `Last command: ${status.lastCommandAt || "-"}`,
    `Last completed: ${status.lastCompletedAt || "-"}`,
    `Agent error: ${status.lastAgentError || "-"}`
  ];
  statusEl.textContent = rows.join(" | ");
}

function renderLogs(logs) {
  logEl.textContent = logs
    .map((entry) => {
      const data = entry.data === undefined ? "" : `\n${JSON.stringify(entry.data, null, 2)}`;
      return `${entry.at} ${entry.message}${data}`;
    })
    .join("\n\n");
}

async function send(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || "Background operator did not respond");
  return response.result;
}

async function refresh() {
  try {
    const status = await send("status");
    renderStatus(status);
    renderLogs(status.logs || []);
  } catch (error) {
    statusEl.textContent = `Background unavailable: ${String(error?.message ?? error)}`;
  }
}

document.querySelector("#connect").addEventListener("click", async () => {
  await send("connect");
  await refresh();
});

document.querySelector("#attach").addEventListener("click", async () => {
  await send("attach-active");
  await refresh();
});

document.querySelector("#detach").addEventListener("click", async () => {
  await send("detach");
  await refresh();
});

refresh();
setInterval(refresh, 1000);
