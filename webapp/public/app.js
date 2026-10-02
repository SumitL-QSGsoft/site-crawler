const form = document.getElementById("crawl-form");
const startBtn = document.getElementById("start-btn");
const statusPanel = document.getElementById("status-panel");
const statusBadge = document.getElementById("status-badge");
const statusUrl = document.getElementById("status-url");
const statusElapsed = document.getElementById("status-elapsed");
const statusHint = document.getElementById("status-hint");
const logOutput = document.getElementById("log-output");
const errorMessage = document.getElementById("error-message");
const resultsSection = document.getElementById("results");
const statsGrid = document.getElementById("stats-grid");
const screensList = document.getElementById("screens-list");
const graphMermaid = document.getElementById("graph-mermaid");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const authPanel = document.getElementById("auth-panel");
const authUrl = document.getElementById("auth-url");
const authForm = document.getElementById("auth-form");
const authUsername = document.getElementById("auth-username");
const authPassword = document.getElementById("auth-password");
const authSkipBtn = document.getElementById("auth-skip-btn");

let pollHandle = null;
let elapsedHandle = null;
let crawlStartedAt = null;
let currentJobId = null;
let authPromptShownFor = null; // jobId+url this tab is currently showing the auth panel for

if (window.mermaid) {
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    url: document.getElementById("url").value.trim(),
    maxPages: document.getElementById("maxPages").value,
    maxDepth: document.getElementById("maxDepth").value,
    delayMs: document.getElementById("delayMs").value,
    workers: document.getElementById("workers").value,
    sameOriginOnly: document.getElementById("sameOriginOnly").checked,
  };
  payload.previousJobId = localStorage.getItem(`crawl:${payload.url}`) || undefined;

  resetUi();
  startBtn.disabled = true;
  startBtn.textContent = "Crawling…";
  statusPanel.classList.remove("hidden");
  statusUrl.textContent = payload.url;
  setBadge("running");
  startElapsedTimer();

  try {
    const res = await fetch("/api/crawls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start crawl.");
    currentJobId = data.jobId;
    authPromptShownFor = null;
    pollHandle = setInterval(() => pollJob(data.jobId), 1200);
  } catch (err) {
    showError(err.message);
    finishUi();
  }
});

function resetUi() {
  errorMessage.classList.add("hidden");
  errorMessage.textContent = "";
  logOutput.textContent = "";
  statusHint.classList.add("hidden");
  resultsSection.classList.add("hidden");
  authPanel.classList.add("hidden");
  authForm.reset();
  statsGrid.innerHTML = "";
  screensList.innerHTML = "";
  graphMermaid.textContent = "";
  graphMermaid.removeAttribute("data-processed");
}

function startElapsedTimer() {
  crawlStartedAt = Date.now();
  statusElapsed.textContent = "0s elapsed";
  clearInterval(elapsedHandle);
  elapsedHandle = setInterval(() => {
    const seconds = Math.round((Date.now() - crawlStartedAt) / 1000);
    statusElapsed.textContent = `${seconds}s elapsed`;
    statusHint.classList.toggle("hidden", seconds < 15);
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedHandle);
  elapsedHandle = null;
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/crawls/${jobId}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "Crawl not found.");

    logOutput.textContent = job.logs.map((l) => `[${l.level}] ${l.line}`).join("\n");
    logOutput.scrollTop = logOutput.scrollHeight;

    if (job.status === "needs-auth" && job.pendingAuth) {
      showAuthPrompt(jobId, job.pendingAuth.url);
    } else {
      hideAuthPrompt();
    }

    if (job.status === "done") {
      clearInterval(pollHandle);
      localStorage.setItem(`crawl:${job.startUrl}`, jobId);
      setBadge("done");
      renderResults(job.result);
      finishUi();
    } else if (job.status === "error") {
      clearInterval(pollHandle);
      setBadge("error");
      showError(job.error || "Crawl failed.");
      finishUi();
    } else {
      setBadge(job.status === "needs-auth" ? "needs-auth" : "running");
    }
  } catch (err) {
    clearInterval(pollHandle);
    showError(err.message);
    finishUi();
  }
}

function showAuthPrompt(jobId, loginUrl) {
  const key = `${jobId}|${loginUrl}`;
  if (authPromptShownFor === key) return; // already showing this exact prompt
  authPromptShownFor = key;
  authUrl.textContent = loginUrl;
  authPanel.classList.remove("hidden");
  authUsername.focus();
}

function hideAuthPrompt() {
  if (authPromptShownFor === null) return;
  authPromptShownFor = null;
  authPanel.classList.add("hidden");
  authForm.reset();
}

async function submitAuth(body) {
  if (!currentJobId) return;
  try {
    await fetch(`/api/crawls/${currentJobId}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort - the job's own AUTH_TIMEOUT_MS fallback covers a lost request
  }
  hideAuthPrompt();
  setBadge("running");
}

authForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitAuth({ username: authUsername.value, password: authPassword.value });
});

authSkipBtn.addEventListener("click", () => {
  submitAuth({ cancel: true });
});

function finishUi() {
  startBtn.disabled = false;
  startBtn.textContent = "Start Crawl";
  stopElapsedTimer();
}

function setBadge(status) {
  statusBadge.textContent = status;
  statusBadge.className = `badge badge-${status}`;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove("hidden");
}

function renderResults(result) {
  resultsSection.classList.remove("hidden");
  renderStats(result);
  renderScreens(result.screens);
  renderGraph(result.screens, result.edges);
}

function renderStats(result) {
  const stats = [
    ["Screens updated", result.pagesDone],
    ["Total screens", result.screens.length],
    ["Modals found", result.modalCount],
    ["Actions (buttons)", result.actionCount],
    ["Forms", result.formCount],
  ];
  statsGrid.innerHTML = "";
  for (const [label, value] of stats) {
    const card = el("div", { class: "stat-card" });
    card.appendChild(el("div", { class: "stat-value", text: String(value) }));
    card.appendChild(el("div", { class: "stat-label", text: label }));
    statsGrid.appendChild(card);
  }
}

function renderScreens(screens) {
  screensList.innerHTML = "";
  const sorted = [...screens].sort((a, b) => a.depth - b.depth);
  for (const screen of sorted) {
    screensList.appendChild(renderScreenCard(screen));
  }
}

function renderScreenCard(screen) {
  const card = el("article", { class: "screen-card" });

  const header = el("div", { class: "screen-card-header" });
  header.appendChild(el("h3", { text: screen.title || "(untitled)" }));

  const badges = el("div", { class: "screen-badges" });
  badges.appendChild(el("span", { class: "chip chip-depth", text: `depth ${screen.depth}` }));
  if (screen.isModal) badges.appendChild(el("span", { class: "chip chip-modal", text: "modal" }));
  if (screen.discoveredVia) badges.appendChild(el("span", { class: "chip chip-via", text: screen.discoveredVia }));
  header.appendChild(badges);
  card.appendChild(header);

  card.appendChild(el("a", { class: "screen-url", text: screen.url, attrs: { href: screen.url, target: "_blank", rel: "noopener noreferrer" } }));

  const body = el("div", { class: "screen-body" });

  if (screen.screenshotUrl) {
    const thumb = el("img", { class: "screen-thumb", attrs: { src: screen.screenshotUrl, alt: `Screenshot of ${screen.title || screen.url}` } });
    thumb.addEventListener("click", () => openLightbox(screen.screenshotUrl));
    body.appendChild(thumb);
  }

  const details = el("div", { class: "screen-details" });
  details.appendChild(renderNavigationSection(screen.sections.navigation));
  details.appendChild(renderActionsSection(screen.sections.actions));
  details.appendChild(renderFieldsSection(screen.sections.fields));
  details.appendChild(renderLinksSection(screen.sections.links));
  details.appendChild(renderAriaSection(screen.sections.aria));
  body.appendChild(details);

  card.appendChild(body);
  return card;
}

// A pill for the label plus a small monospace pill for its locator hint, so both are visible
// (and selectable) without needing a tooltip.
function renderLocatorPill(label, locator, chipClass) {
  const pill = el("span", { class: `locator-pill ${chipClass}` });
  pill.appendChild(el("span", { class: "chip-label", text: label }));
  if (locator) pill.appendChild(el("code", { class: "chip-locator", text: locator }));
  return pill;
}

function renderNavigationSection(items) {
  const wrap = el("div", { class: "section" });
  wrap.appendChild(el("h4", { text: `Sub-navigation (${items.length})` }));
  if (!items.length) {
    wrap.appendChild(el("p", { class: "muted", text: "None found." }));
    return wrap;
  }
  const chips = el("div", { class: "chip-row" });
  for (const item of items) chips.appendChild(el("span", { class: "chip chip-nav", text: item }));
  wrap.appendChild(chips);
  return wrap;
}

function renderActionsSection(actions) {
  const wrap = el("div", { class: "section" });
  wrap.appendChild(el("h4", { text: `Buttons (${actions.length})` }));
  if (!actions.length) {
    wrap.appendChild(el("p", { class: "muted", text: "None found." }));
    return wrap;
  }
  const chips = el("div", { class: "chip-row" });
  for (const action of actions) {
    chips.appendChild(renderLocatorPill(action.text, action.locator, "chip-action"));
  }
  wrap.appendChild(chips);
  return wrap;
}

// "## Form fields" is now a single flat table covering every field on the page (matching AutoQA's
// app-map.json shape), so this renders one chip row instead of a form-by-form breakdown.
function renderFieldsSection(fields) {
  const wrap = el("div", { class: "section" });
  wrap.appendChild(el("h4", { text: `Form fields (${fields.length})` }));
  if (!fields.length) {
    wrap.appendChild(el("p", { class: "muted", text: "None found." }));
    return wrap;
  }
  const fieldRow = el("div", { class: "chip-row" });
  for (const field of fields) {
    const label = field.label || field.placeholder || field.name || `(${field.tag})`;
    fieldRow.appendChild(renderLocatorPill(label, field.locator, "chip-field"));
  }
  wrap.appendChild(fieldRow);
  return wrap;
}

function renderAriaSection(aria) {
  const wrap = el("div", { class: "section" });
  const summary = el("details", { class: "links-details" });
  summary.appendChild(el("summary", { text: "ARIA snapshot" }));
  const pre = el("pre", { class: "aria-snapshot", text: aria || "(none captured)" });
  summary.appendChild(pre);
  wrap.appendChild(summary);
  return wrap;
}

function renderLinksSection(links) {
  const wrap = el("div", { class: "section" });
  const summary = el("details", { class: "links-details" });
  summary.appendChild(el("summary", { text: `Links (${links.length})` }));
  const list = el("ul", { class: "link-list" });
  for (const link of links.slice(0, 100)) {
    list.appendChild(el("li", { text: link }));
  }
  summary.appendChild(list);
  wrap.appendChild(summary);
  return wrap;
}

function renderGraph(screens, edges) {
  const idFor = (id) => `n_${id.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const byId = new Map(screens.map((s) => [s.id, s]));
  const lines = ["flowchart LR"];

  for (const screen of screens) {
    const label = sanitizeMermaidLabel(`${screen.title || "(untitled)"} (d${screen.depth})`);
    const shape = screen.isModal ? `("${label}")` : `["${label}"]`;
    lines.push(`  ${idFor(screen.id)}${shape}`);
  }
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const label = sanitizeMermaidLabel(edge.label || "");
    lines.push(`  ${idFor(edge.from)} -->|${label}| ${idFor(edge.to)}`);
  }

  graphMermaid.textContent = lines.join("\n");
  graphMermaid.removeAttribute("data-processed");
  if (window.mermaid) {
    window.mermaid.run({ nodes: [graphMermaid] }).catch(() => { });
  }
}

function sanitizeMermaidLabel(text) {
  return text.replace(/["\[\]{}()\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}

lightbox.addEventListener("click", () => {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((tc) => tc.classList.add("hidden"));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

// Small safe DOM builder: text is always assigned via textContent, never innerHTML, so
// crawled page content (titles, links, button labels) can never inject markup/scripts.
function el(tag, { class: className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  return node;
}
