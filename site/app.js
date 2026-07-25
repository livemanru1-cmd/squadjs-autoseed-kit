import { AUTOSEED_CONFIG } from "./config.js";
import { chooseSeedServer, collectServers, isAvailableSeedServer } from "./selection.js";

const statusNode = document.querySelector("#status");
const recommendedNode = document.querySelector("#recommended");
const serversNode = document.querySelector("#servers");

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function fetchSnapshot(exporter) {
  const url = safeHttpsUrl(exporter.snapshotUrl);
  if (!url) return { ok: false, error: "Нужен HTTPS-адрес snapshot" };

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, snapshot: await response.json() };
  } catch {
    return { ok: false, error: "Нет связи с экспортёром" };
  }
}

async function joinServer(server, button) {
  const url = safeHttpsUrl(server.joinLinkUrl);
  if (!url) {
    statusNode.textContent = "Для join-link нужен HTTPS-адрес.";
    return;
  }

  button.disabled = true;
  statusNode.textContent = `Получаю ссылку для ${server.name}…`;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok || typeof payload?.joinLink !== "string") {
      throw new Error("join-link unavailable");
    }
    const joinUrl = new URL(payload.joinLink);
    if (joinUrl.protocol !== "steam:") throw new Error("unexpected join-link protocol");
    statusNode.textContent = `Открываю ${server.name} в Steam…`;
    window.location.assign(joinUrl.href);
  } catch {
    statusNode.textContent = "Не удалось получить ссылку подключения. Попробуйте ещё раз.";
  } finally {
    button.disabled = false;
  }
}

function createServerCard(server, recommended) {
  const card = document.createElement("article");
  card.className = "server-card";
  if (recommended) card.dataset.recommended = "true";

  const title = document.createElement("h3");
  title.textContent = server.name;
  const state = document.createElement("p");
  state.className = "server-state";
  state.textContent = server.online && server.fresh ? "В сети" : "Нет свежих данных";
  const players = document.createElement("p");
  players.textContent = `Игроки: ${server.playerCount}/${server.maxPlayers || "?"}, очередь: ${server.queueLength}`;
  const layer = document.createElement("p");
  layer.textContent = server.currentLayer ? `Слой: ${server.currentLayer}` : "Слой пока неизвестен";
  const priority = document.createElement("p");
  priority.textContent = `Приоритет: ${server.priority}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = recommended ? "Подключиться на сид" : "Подключиться";
  button.disabled = !isAvailableSeedServer(server);
  button.addEventListener("click", () => joinServer(server, button));

  card.append(title, state, players, layer, priority, button);
  return card;
}

function render(servers) {
  const recommended = chooseSeedServer(servers);
  recommendedNode.textContent = recommended
    ? `Рекомендуемый сервер: ${recommended.name}`
    : "Сейчас нет доступного сервера для сида.";
  serversNode.replaceChildren(
    ...servers.map((server) => createServerCard(server, server.code === recommended?.code))
  );
  statusNode.textContent = `Обновлено: ${new Date().toLocaleTimeString("ru-RU")}`;
}

async function refresh() {
  statusNode.textContent = "Обновляю состояние серверов…";
  const results = await Promise.all(AUTOSEED_CONFIG.exporters.map(fetchSnapshot));
  render(collectServers(results, AUTOSEED_CONFIG));
}

await refresh();
window.setInterval(refresh, Math.max(5000, Number(AUTOSEED_CONFIG.refreshIntervalMs) || 15000));
