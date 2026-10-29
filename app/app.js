// Comfy Mobile: run ComfyUI workflows saved with "Send to phone".
// Talks to the ComfyUI server that serves this page: /prompt, /ws, /history,
// /view, /upload/image, plus /mobile/api/* from this custom node.

const $ = (sel, root = document) => root.querySelector(sel);

const views = { home: $("#view-home"), template: $("#view-template"), recent: $("#view-recent") };

const state = {
  templates: null,   // summaries from /mobile/api/templates
  current: null,     // the open template, with its API prompt
  values: {},        // what the user typed/picked for the open template, by field key
  files: {},         // field key -> { file, url } picked but not uploaded yet
  job: null,         // the one run this phone is tracking
  queueRemaining: 0,
  recent: { kind: "all", items: [], total: 0, kinds: {} },
};

// ------------------------------------------------------------ helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...childNodes(children));
  return el;
}

// Children may be nested arrays, and null/false/"" mean "nothing here".
const childNodes = (children) => children.flat(Infinity).filter((c) => c != null && c !== false && c !== "");

// replaceChildren with the same child rules as h().
function fill(el, ...children) {
  el.replaceChildren(...childNodes(children));
  return el;
}

const ICONS = {
  spark: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  model: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
};

function icon(name) {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
  return wrap.firstChild;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("cm." + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem("cm." + key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem("cm." + key); } catch {}
  },
};

// crypto.randomUUID needs https; a Tailscale http:// address isn't a secure context.
function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const clientId = store.get("clientId") || uuid();
store.set("clientId", clientId);
state.recent.kind = store.get("recentKind", "all");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let toastTimer;
function toast(message) {
  let el = $(".toast");
  if (!el) document.body.append((el = h("div", { class: "toast", role: "status" })));
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function errorBox(title, message) {
  return h("div", { class: "error-box" }, h("b", {}, title), h("p", {}, message || "Unknown error"));
}

// ------------------------------------------------------------ media

const EXTENSIONS = {
  image: /\.(png|jpe?g|webp|gif|bmp|avif)$/i,
  video: /\.(mp4|webm|mov|mkv|m4v)$/i,
  audio: /\.(wav|mp3|flac|ogg|opus|m4a|aac)$/i,
  model: /\.(glb|gltf|obj|fbx|ply|stl|usdz)$/i,
};

function kindOf(filename) {
  for (const [kind, re] of Object.entries(EXTENSIONS)) if (re.test(filename)) return kind;
  return "file";
}

function viewUrl(item) {
  const q = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output" });
  return `/view?${q}`;
}

// Animated GIF/WebP would lose their animation as a JPEG preview, so those load as they are.
const previewUrl = (item) => (/\.(gif|webp)$/i.test(item.filename) ? viewUrl(item) : thumbUrl(item, 1600));

function thumbUrl(item, size = 384) {
  const q = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output", size });
  return `/mobile/api/thumb?${q}`;
}

// A LoadImage value like "mobile/photo.jpg" or "photo.png [output]".
function parseInputValue(value) {
  let name = String(value || "");
  let type = "input";
  const m = name.match(/^(.*) \[(input|output|temp)\]$/);
  if (m) [, name, type] = m;
  const i = name.lastIndexOf("/");
  return { filename: i < 0 ? name : name.slice(i + 1), subfolder: i < 0 ? "" : name.slice(0, i), type };
}

// History or "executed" outputs -> a flat list of files and texts. Saved files win over temp previews.
function outputsOf(outputs) {
  const items = [];
  const seen = new Set();
  for (const out of Object.values(outputs || {})) {
    for (const [key, list] of Object.entries(out || {})) {
      if (!Array.isArray(list)) continue;
      for (const x of list) {
        if (x && typeof x === "object" && x.filename) {
          const id = `${x.type}/${x.subfolder}/${x.filename}`;
          if (seen.has(id)) continue;
          seen.add(id);
          items.push({ filename: x.filename, subfolder: x.subfolder || "", type: x.type || "output", kind: kindOf(x.filename) });
        } else if (typeof x === "string" && key === "text") {
          items.push({ kind: "text", text: x });
        }
      }
    }
  }
  const saved = items.filter((x) => x.kind === "text" || x.type === "output");
  return saved.some((x) => x.kind !== "text") ? saved : items;
}

async function shrinkImage(file, maxSide = 2560) {
  if (!/^image\/(jpe?g|heic|heif)$/i.test(file.type) || typeof createImageBitmap !== "function") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close?.();
    return file;
  }
  const canvas = h("canvas", { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  return blob ? new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
}

// ------------------------------------------------------------ server

function errorMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 400);
  const nodeError = Object.values(data.node_errors || {})[0];
  if (nodeError?.errors?.length) {
    const e = nodeError.errors[0];
    return `${nodeError.class_type}: ${e.message}${e.details ? ` (${e.details})` : ""}`;
  }
  if (data.error?.message) return data.error.message + (data.error.details ? `: ${data.error.details}` : "");
  if (typeof data.error === "string") return data.error;
  return "";
}

const OFFLINE = "Can't reach your PC. Check that Tailscale is on and ComfyUI is open.";

// Errors carry `network: true` when no answer came back (offline, or slower than `timeout`), and
// `status`/`data` when ComfyUI answered with an error. The timeout keeps a request on a dead
// connection from hanging the app, and the job checks that wait on it, forever.
async function api(path, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let res, text;
    try {
      res = await fetch(path, { ...options, signal: controller.signal });
      text = await res.text();
    } catch {
      throw Object.assign(new Error(OFFLINE), { network: true });
    }
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      throw Object.assign(new Error(errorMessage(data) || `${res.status} ${res.statusText}`), { status: res.status, data });
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const postJson = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// XMLHttpRequest rather than fetch, because only it reports upload progress (videos can take a while
// on mobile data). `job.abortUpload` lets Cancel stop it.
function uploadFile(file, job, onProgress) {
  const form = new FormData();
  form.append("image", file, file.name || "upload");
  form.append("type", "input");
  form.append("subfolder", "mobile");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload/image");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 413) {
        // ComfyUI refuses uploads over --max-upload-size (100 MB by default); phone videos often are.
        reject(new Error(tooBigMessage(file)));
      } else if (xhr.status < 200 || xhr.status >= 300 || !data?.name) {
        reject(new Error(errorMessage(data ?? xhr.responseText) || `Upload failed (${xhr.status})`));
      } else {
        resolve(data.subfolder ? `${data.subfolder}/${data.name}` : data.name);
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error(OFFLINE), { network: true }));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    job.abortUpload = () => xhr.abort();
    xhr.send(form);
  });
}

// ------------------------------------------------------------ connection

const conn = { ws: null, open: false, retry: 0, timer: null, openedAt: 0, lastMessageAt: 0 };

// This page changes as soon as its files do; the server part only when ComfyUI restarts.
// Matches API_VERSION in __init__.py.
const NEEDS_API = 4;
let maxUploadBytes = 100 * 1048576; // ComfyUI's --max-upload-size (MiB), updated from the server

async function checkServerVersion() {
  let version = 0;
  try {
    const info = await api("/mobile/api/version");
    version = info.version;
    if (info.max_upload_mb) maxUploadBytes = info.max_upload_mb * 1024 * 1024;
  } catch (e) {
    if (e.status !== 404) return; // offline: nothing to tell yet
  }
  $("#update").hidden = version >= NEEDS_API;
}

function connect() {
  if (conn.ws && conn.ws.readyState <= WebSocket.OPEN) return;
  setConn("wait");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?clientId=${clientId}`);
  ws.binaryType = "arraybuffer";
  conn.ws = ws;
  ws.onopen = () => {
    conn.retry = 0;
    conn.openedAt = conn.lastMessageAt = Date.now();
    setConn("ok");
    syncJob();
    checkServerVersion();
  };
  ws.onmessage = (event) => {
    conn.lastMessageAt = Date.now();
    onSocketMessage(event);
  };
  ws.onclose = () => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    setConn("down");
    clearTimeout(conn.timer);
    conn.timer = setTimeout(connect, Math.min(10000, 1000 * 2 ** conn.retry++));
  };
  ws.onerror = () => ws.close();
}

// A socket can look open after the phone slept while the connection behind it is gone, and then
// no progress arrives. Closing it makes onclose reconnect.
function recycleSocket() {
  if (conn.ws) conn.ws.close();
}

let offlineTimer;
function setConn(status) {
  conn.open = status === "ok";
  const el = $("#conn");
  el.className = "conn" + (status === "ok" ? " ok" : status === "down" ? " down" : "");
  el.setAttribute("aria-label", status === "ok" ? "Connected to your PC" : "Not connected");
  clearTimeout(offlineTimer);
  if (status === "ok") $("#offline").hidden = true;
  else offlineTimer = setTimeout(() => ($("#offline").hidden = conn.open), 2500);
}

function onSocketMessage(event) {
  if (typeof event.data !== "string") return onPreview(event.data);
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  const { type, data } = msg;
  if (type === "status") {
    state.queueRemaining = data?.status?.exec_info?.queue_remaining ?? 0;
    updateRunCard();
    return;
  }
  const job = state.job;
  if (!job || job.finished || !data || data.prompt_id !== job.promptId) return;
  job.lastEventAt = Date.now();

  switch (type) {
    case "execution_start":
      markRunning(job);
      break;
    case "execution_cached":
      for (const id of data.nodes || []) job.cached.add(String(id));
      break;
    case "executing":
      markRunning(job);
      if (data.node == null) {
        finishFromHistory(job);
        break;
      }
      if (job.node && job.node !== String(data.node)) job.done.add(job.node);
      job.node = String(data.node);
      break;
    case "progress": {
      markRunning(job);
      const node = String(data.node ?? job.node);
      const now = Date.now();
      const s = job.step;
      if (!s || s.node !== node || data.value < s.value) {
        job.step = { node, value: data.value, max: data.max, firstValue: data.value, firstAt: now, lastAt: now };
      } else {
        Object.assign(s, { value: data.value, max: data.max, lastAt: now });
      }
      break;
    }
    case "progress_state":
      for (const [id, n] of Object.entries(data.nodes || {})) if (n.state === "finished") job.done.add(String(id));
      break;
    case "executed":
      job.outputs = [...job.outputs, ...outputsOf({ [data.node]: data.output })];
      break;
    case "execution_success":
      finishFromHistory(job);
      break;
    case "execution_error":
      finishJob(job, "error", [data.node_type, data.exception_message].filter(Boolean).join(": ") || "The run failed.");
      break;
    case "execution_interrupted":
      finishJob(job, "cancelled");
      break;
  }
  updateRunCard();
}

// Live sampler previews arrive as binary frames: [event=1][format: 1 jpeg, 2 png][image bytes].
// The server only sends them to the client that queued the run, but they carry no prompt id, so
// only take them while our job is the one running (not an older run of ours still ahead of it).
function onPreview(buffer) {
  const job = state.job;
  if (!job || job.finished || job.status !== "running" || buffer.byteLength < 8) return;
  const view = new DataView(buffer);
  if (view.getUint32(0) !== 1) return;
  const blob = new Blob([buffer.slice(8)], { type: view.getUint32(4) === 2 ? "image/png" : "image/jpeg" });
  if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
  job.previewUrl = URL.createObjectURL(blob);
  updateRunCard();
}

// ------------------------------------------------------------ jobs

function persistJob(job) {
  const { promptId, templateId, templateName, submittedAt, startedAt, total } = job;
  store.set("job", { promptId, templateId, templateName, submittedAt, startedAt, total });
}

function newJob(template, prompt, saved) {
  return {
    promptId: uuid(),
    templateId: template?.id,
    templateName: template?.name,
    prompt,
    total: prompt ? Object.keys(prompt).length : 0,
    submittedAt: Date.now(),
    startedAt: null,
    status: "uploading",
    finished: false,
    done: new Set(),
    cached: new Set(),
    node: null,
    step: null,
    outputs: [],
    previewUrl: null,
    lastEventAt: Date.now(),
    ...saved,
  };
}

function markRunning(job) {
  if (job.status === "running") return;
  job.status = "running";
  job.startedAt ??= Date.now();
  persistJob(job);
  renderStage();
}

async function fetchHistoryEntry(promptId) {
  const hist = await api(`/history/${promptId}`, {}, 15000);
  return hist?.[promptId] || null;
}

function finishWithEntry(job, entry) {
  const status = entry.status || {};
  const messages = status.messages || [];
  const error = messages.find((m) => m[0] === "execution_error")?.[1];
  // How long ComfyUI actually ran it, from its own timestamps: right even if the phone slept.
  const at = Object.fromEntries(messages.map(([name, data]) => [name, data?.timestamp]));
  const runMs = at.execution_start && at.execution_success ? at.execution_success - at.execution_start : null;
  if (messages.some((m) => m[0] === "execution_interrupted")) finishJob(job, "cancelled");
  else if (status.status_str === "error" || error) {
    finishJob(job, "error", error ? [error.node_type, error.exception_message].filter(Boolean).join(": ") : "The run failed.");
  } else finishJob(job, "done", null, outputsOf(entry.outputs), runMs);
}

// "pending" | "in_progress" | "completed" | "failed" | "cancelled", or "unknown" when ComfyUI has
// never heard of the id. One small request; /queue would download every queued workflow.
async function jobStatus(promptId) {
  try {
    return (await api(`/api/jobs/${promptId}`, {}, 15000)).status;
  } catch (e) {
    if (e.status !== 404) throw e;
    if (e.data?.error === "Job not found") return "unknown";
  }
  // A ComfyUI without /api/jobs: history, then the queue.
  if (await fetchHistoryEntry(promptId)) return "completed";
  const queue = await api("/queue", {}, 15000);
  const has = (list) => (list || []).some((item) => item[1] === promptId);
  return has(queue.queue_running) ? "in_progress" : has(queue.queue_pending) ? "pending" : "unknown";
}

// History is written a moment after "execution_success", so retry briefly before
// falling back to the outputs the socket already delivered.
async function finishFromHistory(job) {
  for (let i = 0; i < 15 && !job.finished; i++) {
    const entry = await fetchHistoryEntry(job.promptId).catch(() => null);
    if (entry) return finishWithEntry(job, entry);
    await sleep(400);
  }
  if (!job.finished) finishJob(job, "done", null, job.outputs);
}

// Catch up after the phone slept, the page reloaded, or the socket dropped.
async function syncJob() {
  const job = state.job;
  // While the run is being sent, ComfyUI may not know it yet; that's not "missing".
  if (!job || job.finished || job.status === "uploading" || job.posting || job.syncing) return;
  job.syncing = true;
  job.lastSyncAt = Date.now();
  try {
    const status = await jobStatus(job.promptId);
    if (job.finished) return;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      await finishFromHistory(job);
      return;
    }
    if (status === "in_progress" || status === "pending") {
      job.missingOnce = false;
      if (status === "in_progress") markRunning(job);
      else job.status = "queued";
    } else if (!job.missingOnce) {
      job.missingOnce = true; // it may be between "running" and "history"; look once more
      setTimeout(syncJob, 1500);
    } else if (job.postUncertain) {
      finishJob(job, "error", "Your PC didn't get this run: the connection dropped while sending it. Tap Generate to try again.");
    } else {
      finishJob(job, "error", "This run is no longer on your PC. ComfyUI may have restarted.");
    }
    job.lastEventAt = Date.now();
    updateRunCard();
  } catch {
    // offline: the socket's reconnect and the ticker call this again
  } finally {
    job.syncing = false;
  }
}

function recordDuration(templateId, ms) {
  const list = store.get("dur." + templateId, []);
  list.push(ms);
  store.set("dur." + templateId, list.slice(-5));
}

function typicalMs(templateId) {
  const list = [...store.get("dur." + templateId, [])].sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : null;
}

// `runMs` is how long ComfyUI ran it (from history). Only that is learned as the template's typical
// time: the phone's own clock includes however long it slept.
function finishJob(job, status, error, outputs, runMs) {
  if (job.finished) return;
  Object.assign(job, { finished: true, status, error: error || null, finishedAt: Date.now(), runMs: runMs ?? null });
  if (outputs) job.outputs = outputs;
  if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
  job.previewUrl = null;
  store.del("job");
  stopTicker();

  if (status === "done") {
    if (runMs > 0) recordDuration(job.templateId, runMs);
    store.set("last." + job.templateId, { items: job.outputs.slice(0, 24), at: job.finishedAt });
    const firstVisual = job.outputs.find((x) => x.kind === "image" || x.kind === "video");
    if (firstVisual) store.set("thumb." + job.templateId, thumbUrl(firstVisual, 160));
    if (document.hidden) document.title = "✓ Done · Comfy";
  }
  renderStage();
  renderJobPill();
  if (!views.home.hidden) renderHome();
}

let ticker = null;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    updateRunCard();
    renderJobPill();
    const job = state.job;
    if (!job || document.hidden) return;
    const now = Date.now();
    // An open socket that has said nothing for 30 s during a run is probably dead (see recycleSocket).
    if (job.status === "running" && conn.open && now - conn.lastMessageAt > 30000 && now - conn.openedAt > 30000) recycleSocket();
    if (now - (job.lastSyncAt || 0) < 5000) return;
    if (!conn.open || now - job.lastEventAt > 15000) syncJob();
  }, 500);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

// ------------------------------------------------------------ run

const fieldKey = (f) => `${f.node}.${f.input}`;
const isMedia = (f) => f.kind === "image" || f.kind === "video" || f.kind === "audio";
// The workflow's own file isn't on the PC and nothing else has been picked or uploaded yet.
const needsPick = (f) => isMedia(f) && f.missing && !state.files[fieldKey(f)] && state.values[fieldKey(f)] === f.value;

function clamp(n, min, max) {
  if (min != null && n < Number(min)) return Number(min);
  if (max != null && n > Number(max)) return Number(max);
  return n;
}

function randomSeed(seedFields) {
  const max = Math.min(2 ** 48, ...seedFields.map((f) => Number(f.max) || 2 ** 48));
  return Math.floor(Math.random() * max);
}

function applyValues(prompt, template, v) {
  const seeds = template.fields.filter((f) => f.kind === "seed");
  if (seeds.length && (v.seedRandom || !Number.isFinite(parseInt(v.seed, 10)))) v.seed = randomSeed(seeds);
  for (const f of template.fields) {
    const node = prompt[f.node];
    if (!node) continue;
    const key = fieldKey(f);
    if (f.kind === "seed") {
      node.inputs[f.input] = clamp(parseInt(v.seed, 10), f.min, f.max);
    } else if (f.kind === "number") {
      const n = f.type === "INT" ? parseInt(v[key], 10) : parseFloat(v[key]);
      node.inputs[f.input] = Number.isFinite(n) ? clamp(n, f.min, f.max) : f.value;
    } else if (f.kind === "select") {
      // <select> gives strings back; keep the option's own type (some lists hold numbers).
      node.inputs[f.input] = (f.options || []).find((o) => String(o) === String(v[key])) ?? v[key];
    } else if (key in v) {
      node.inputs[f.input] = v[key];
    }
  }
}

async function generate() {
  const template = state.current;
  if (!template || (state.job && !state.job.finished)) return;
  if (document.activeElement?.blur) document.activeElement.blur();
  const unpicked = template.fields.find(needsPick);
  if (unpicked) return toast(`Choose ${fieldLabel(unpicked, template.fields).toLowerCase()} first`);

  const tooBig = template.fields.map((f) => state.files[fieldKey(f)]?.file).find((file) => file && file.size > maxUploadBytes);
  if (tooBig) return toast(tooBigMessage(tooBig));

  // The run works on its own copies: opening another template while this one uploads replaces
  // state.values and state.files with that template's.
  const values = { ...state.values };
  const files = { ...state.files };
  const prompt = structuredClone(template.prompt);
  const job = newJob(template, prompt);
  state.job = job;
  renderStage();
  window.scrollTo({ top: 0, behavior: "smooth" });
  startTicker();

  try {
    const uploads = template.fields.filter((f) => isMedia(f) && files[fieldKey(f)]);
    for (const [index, f] of uploads.entries()) {
      if (job.finished) return; // cancelled
      const key = fieldKey(f);
      const pick = files[key];
      job.upload = { index, count: uploads.length, fraction: 0 };
      const file = f.kind === "image" ? await shrinkImage(pick.file) : pick.file;
      if (job.finished) return;
      values[key] = await uploadFile(file, job, (fraction) => {
        job.upload.fraction = fraction;
        updateRunCard();
      });
      // Uploaded: from now on the template uses the file on the PC instead of sending it again.
      if (state.current?.id === template.id && state.files[key] === pick) {
        state.values[key] = values[key];
        delete state.files[key];
        URL.revokeObjectURL(pick.url);
      }
    }
    if (job.finished) return;
    applyValues(prompt, template, values);
    saveValues(template, values);
    if (state.current?.id === template.id) {
      // The seed field shows the seed this run used, so it can be locked to repeat it.
      state.values.seed = values.seed;
      const seedInput = $("#seed-input");
      if (seedInput) seedInput.value = values.seed;
    }
    job.status = "queued";
    job.lastEventAt = job.lastSyncAt = Date.now();
    persistJob(job);
    renderStage();
    job.posting = postJson("/prompt", {
      prompt,
      prompt_id: job.promptId,
      client_id: clientId,
      extra_data: { preview_method: "auto" },
    });
    try {
      await job.posting;
    } catch (e) {
      if (!e.network) throw e; // ComfyUI said no, e.g. a missing model
      // The run may have reached the PC before the connection dropped. Ask it rather than guess:
      // sending again could queue it twice.
      job.postUncertain = true;
    } finally {
      job.posting = null;
    }
    if (job.postUncertain) syncJob();
  } catch (e) {
    finishJob(job, "error", e.message);
  }
}

function tooBigMessage(file) {
  return `"${file.name}" is ${Math.round(file.size / 1048576)} MB; your PC accepts up to ${Math.round(maxUploadBytes / 1048576)} MB. Trim it or record at a lower resolution.`;
}

async function cancelJob() {
  const job = state.job;
  if (!job || job.finished) return;
  if (job.status === "uploading") {
    job.abortUpload?.();
    return finishJob(job, "cancelled");
  }
  // The run has to be on the PC before it can be cancelled there.
  if (job.posting) await job.posting.catch(() => {});
  if (job.finished) return;
  let cancelled = false;
  try {
    cancelled = (await api(`/api/jobs/${job.promptId}/cancel`, { method: "POST" }, 15000)).cancelled;
  } catch (e) {
    if (e.network) return toast(e.message); // nothing was cancelled
    // A ComfyUI without /api/jobs: interrupt it if running, drop it if waiting.
    await postJson("/interrupt", { prompt_id: job.promptId }).catch(() => {});
    await postJson("/queue", { delete: [job.promptId] }).catch(() => {});
    cancelled = true;
  }
  if (!cancelled) return syncJob(); // it had already finished, or never arrived
  if (job.status === "queued") finishJob(job, "cancelled"); // a queued run leaves no event behind
  else setTimeout(syncJob, 1500);
}

function phaseLabel(node) {
  if (!node) return "Working";
  const c = node.class_type || "";
  if (/^Load(Image|Video|Audio)/i.test(c)) return "Reading your input";
  if (/Load|Loader/i.test(c)) return "Loading models";
  if (/TextEncode|CLIPText/i.test(c)) return "Reading your prompt";
  if (/Sampler|Sample/i.test(c)) return "Generating";
  if (/Decode/i.test(c)) return "Finishing";
  if (/Upscale/i.test(c)) return "Upscaling";
  if (/^(Save|Preview)/i.test(c)) return "Saving";
  return node._meta?.title || c;
}

function describeJob(job) {
  const now = Date.now();
  if (job.status === "uploading") {
    const u = job.upload || { index: 0, count: 1, fraction: 0 };
    return {
      phase: u.count > 1 ? `Uploading ${u.index + 1} of ${u.count}…` : "Uploading…",
      step: `${Math.round(u.fraction * 100)}%`,
      fraction: (u.index + u.fraction) / u.count,
      time: "",
      left: null,
    };
  }
  if (job.status === "queued") {
    const ahead = Math.max(0, state.queueRemaining - 1);
    return { phase: "Waiting for your PC", step: ahead ? `${ahead} ahead` : "", fraction: null, time: `${fmtTime(now - job.submittedAt)} waiting`, left: null };
  }

  const elapsed = now - (job.startedAt || job.submittedAt);
  const s = job.step;
  const sampling = s && s.max > 1 && s.node === job.node;
  let left = null;
  if (sampling && s.value > s.firstValue) {
    const perStep = (s.lastAt - s.firstAt) / (s.value - s.firstValue);
    left = Math.max(0, perStep * (s.max - s.value) - (now - s.lastAt));
  }
  // Steps alone miss what comes after them (decoding a video takes a while), so a past run's
  // length wins when it says more time is left.
  const typical = typicalMs(job.templateId);
  if (typical) left = Math.max(left ?? 0, typical - elapsed);

  let fraction;
  if (typical) {
    fraction = elapsed / typical;
  } else {
    const total = Math.max(1, job.total - job.cached.size);
    fraction = (job.done.size + (sampling ? s.value / s.max : 0)) / total;
  }
  return {
    phase: job.node ? phaseLabel(job.prompt?.[job.node]) : "Starting",
    step: sampling ? `step ${s.value}/${s.max}` : "",
    fraction: Math.min(0.97, fraction),
    time: fmtTime(elapsed) + (left != null ? ` · about ${fmtTime(left)} left` : ""),
    left,
  };
}

// ------------------------------------------------------------ values

function defaultValues(template) {
  const v = { seedRandom: true, seed: "" };
  for (const f of template.fields) {
    if (f.kind === "seed") v.seed = v.seed === "" ? f.value : v.seed;
    else v[fieldKey(f)] = f.value;
  }
  return v;
}

// Only what the user changed is remembered, so a template re-sent from the PC with
// new defaults (a different model, a new size) reaches the phone.
function loadValues() {
  const template = state.current;
  const defaults = defaultValues(template);
  const saved = store.get("vals." + template.id, null);
  let overrides = saved?.v === 2 ? { ...saved.overrides } : {};
  if (saved && saved.v !== 2) {
    // Saved by an older version, which kept every value: trust only typed prompts and uploads.
    const typed = new Set(template.fields.filter((f) => f.kind === "text" || isMedia(f)).map(fieldKey));
    for (const [key, value] of Object.entries(saved)) {
      if (typed.has(key) && String(value) !== String(defaults[key])) overrides[key] = value;
    }
  }
  for (const key of Object.keys(overrides)) if (!(key in defaults)) delete overrides[key];
  state.values = { ...defaults, ...overrides };
  clearPicks();
}

function saveValues(template = state.current, values = state.values) {
  if (!template) return;
  const defaults = defaultValues(template);
  const overrides = {};
  for (const [key, value] of Object.entries(values)) {
    const changed = key === "seed" ? !values.seedRandom : String(value) !== String(defaults[key]);
    if (changed) overrides[key] = value;
  }
  store.set("vals." + template.id, { v: 2, overrides });
}

let saveTimer;
function saveValuesSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveValues, 400);
}

// Picked files hold their preview URL (and the File) in memory until revoked.
function clearPicks() {
  for (const pick of Object.values(state.files)) URL.revokeObjectURL(pick.url);
  state.files = {};
}

function resetValues() {
  state.values = defaultValues(state.current);
  clearPicks();
  saveValues();
  renderTemplate();
  toast("Back to the workflow's defaults");
}

// ------------------------------------------------------------ views

function show(view, title, back) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  $("#title").textContent = title;
  $("#back").hidden = !back;
  for (const a of document.querySelectorAll(".tabs a")) {
    a.classList.toggle("active", a.dataset.tab === (view === "recent" ? "recent" : "create"));
  }
  document.body.classList.toggle("on-template", view === "template");
  renderJobPill();
}

// Shows the running job from other screens ("Photo to video · about 2:10 left"), then "ready"
// until its result has been seen. Tapping it opens the template.
function renderJobPill() {
  const pill = $("#job-pill");
  const job = state.job;
  const onItsPage = job && !views.template.hidden && state.current?.id === job.templateId;
  if (!job || !job.templateId || onItsPage || (job.finished && job.seen) || job.status === "cancelled") {
    pill.hidden = true;
    return;
  }
  const name = job.templateName || "Your workflow";
  let text;
  if (!job.finished) {
    const d = describeJob(job);
    text = `${name} · ${d.left != null ? `about ${fmtTime(d.left)} left` : d.phase}`;
  } else {
    text = job.status === "done" ? `✓ ${name} is ready` : `${name} didn't work`;
  }
  pill.textContent = text;
  pill.className = "job-pill" + (job.finished ? (job.status === "done" ? " done" : " failed") : "");
  pill.href = `#/t/${encodeURIComponent(job.templateId)}`;
  pill.hidden = false;
}

function route() {
  closeViewer();
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "t" && id) showTemplate(decodeURIComponent(id));
  else if (page === "recent") showRecent();
  else showHome();
}

// ---- home

const KIND_NAMES = { image: "Photo", video: "Video", audio: "Audio" };

function summary(fields) {
  const parts = [];
  if (fields.some((f) => f.kind === "text" && f.role === "positive")) parts.push("Prompt");
  for (const kind of ["image", "video", "audio"]) {
    const n = fields.filter((f) => f.kind === kind).length;
    if (n) parts.push(n > 1 ? `${n} ${KIND_NAMES[kind].toLowerCase()}s` : KIND_NAMES[kind]);
  }
  return parts.join(" · ") || "Runs as saved";
}

function templateIcon(t) {
  if (t.category === "video") return "video";
  const kinds = t.fields.map((f) => f.kind);
  return kinds.includes("image") ? "image" : kinds.includes("video") ? "video" : kinds.includes("audio") ? "audio" : "spark";
}

const CATEGORIES = [
  { key: "photo", tools: "Photo tools", files: "Photos" },
  { key: "video", tools: "Video tools", files: "Videos" },
  { key: "audio", tools: "Audio tools", files: "Audio" },
  { key: "3d", tools: "3D tools", files: "3D" },
];
const categoryOf = (t) => t.category || "photo";
const FILE_CATEGORY = { image: "photo", video: "video", audio: "audio", model: "3d" };

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 5 ? "a few seconds" : s < 60 ? `about ${s} s` : `about ${Math.round(s / 60)} min`;
}

// A row of buttons that switch between categories: [[key, label, count?], ...]
function segmented(options, active, onPick) {
  return h("div", { class: "segmented", role: "tablist" },
    options.map(([key, label, count]) =>
      h("button", {
        type: "button", role: "tab", class: key === active ? "active" : "",
        "aria-selected": key === active ? "true" : "false", onclick: () => onPick(key),
      }, label, count != null ? h("span", { class: "count" }, String(count)) : null)));
}

async function removeTemplate(template) {
  if (!confirm(`Remove "${template.name}" from your phone?\n\nIt stays in ComfyUI on your PC.`)) return;
  try {
    await api(`/mobile/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
    for (const key of ["vals.", "last.", "thumb.", "dur."]) store.del(key + template.id);
    state.templates = state.templates.filter((t) => t.id !== template.id);
    renderHome();
  } catch (e) {
    toast(`Couldn't remove it: ${e.message}`);
  }
}

function templateCard(t) {
  const thumb = store.get("thumb." + t.id, null);
  const running = state.job && !state.job.finished && state.job.templateId === t.id;
  const typical = typicalMs(t.id);
  const meta = running ? "Generating…" : [summary(t.fields), typical ? fmtDuration(typical) : null].filter(Boolean).join(" · ");
  return h("div", { class: "card" },
    h("a", { class: "card-link", href: `#/t/${encodeURIComponent(t.id)}` },
      h("div", { class: "thumb" }, thumb
        ? h("img", { src: thumb, alt: "", loading: "lazy", onerror: (e) => e.target.replaceWith(icon(templateIcon(t))) })
        : icon(templateIcon(t))),
      h("div", { class: "info" },
        h("div", { class: "name" }, t.name),
        h("div", { class: "meta" }, meta))),
    h("button", { class: "more", type: "button", "aria-label": `Remove ${t.name}`, onclick: () => removeTemplate(t) }, "⋯"));
}

function renderHome() {
  const root = views.home;
  if (state.templates == null) {
    root.replaceChildren(h("p", { class: "hint-line" }, "Loading…"));
    return;
  }
  if (!state.templates.length) {
    root.replaceChildren(h("div", { class: "empty" },
      h("h2", {}, "No workflows yet"),
      h("p", {}, "On your PC, open a workflow in ComfyUI and click ", h("b", {}, "Send to phone"), " (the phone icon at the top)."),
      h("p", {}, "It's also under ", h("b", {}, "Workflow"), " in the menu, and in the right-click menu on the canvas.")));
    return;
  }
  // One collapsible list per category ("Photo tools", "Video tools"); open/closed is remembered.
  fill(root, CATEGORIES.map((c) => {
    const list = state.templates.filter((t) => categoryOf(t) === c.key).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return null;
    return h("details", { class: "group", open: store.get("open." + c.key, true), ontoggle: (e) => store.set("open." + c.key, e.target.open) },
      h("summary", {}, h("span", { class: "group-title" }, c.tools), h("span", { class: "count" }, String(list.length))),
      h("div", { class: "cards" }, list.map(templateCard)));
  }));
}

async function showHome() {
  show("home", "Comfy", false);
  renderHome();
  try {
    state.templates = await api("/mobile/api/templates");
    if (!views.home.hidden) renderHome();
  } catch (e) {
    if (state.templates == null) views.home.replaceChildren(errorBox("Can't load your workflows", e.message));
  }
}

// ---- template

function labelFor(f, siblings) {
  const sameTitle = siblings.filter((o) => o.title === f.title).length > 1;
  return sameTitle ? `${f.title} · ${f.input}` : f.title;
}

function textField(f, label) {
  const key = fieldKey(f);
  const id = "f-" + key.replace(/\W/g, "_");
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    h("textarea", {
      id,
      rows: f.role === "negative" ? 3 : 5,
      placeholder: f.role === "negative" ? "Things to avoid (optional)" : "Describe what you want…",
      value: state.values[key] ?? "",
      oninput: (e) => { state.values[key] = e.target.value; saveValuesSoon(); },
    }));
}

function mediaField(f, label) {
  const key = fieldKey(f);
  const pick = state.files[key];
  const current = parseInputValue(state.values[key]);
  const noun = KIND_NAMES[f.kind].toLowerCase();

  let preview;
  if (f.kind === "image" && (pick || current.filename)) {
    preview = h("img", { src: pick ? pick.url : thumbUrl(current, 200), alt: "", onerror: (e) => e.target.replaceWith(icon("image")) });
  } else if (f.kind === "video" && pick) {
    preview = h("video", { src: pick.url + "#t=0.1", muted: true, playsinline: true, preload: "metadata" });
  } else {
    preview = icon(f.kind);
  }

  const wrap = h("div", { class: "field" },
    h("span", { class: "label" }, label),
    h("label", { class: "media" },
      h("input", {
        type: "file",
        accept: `${f.kind}/*`,
        onchange: (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > maxUploadBytes) {
            e.target.value = "";
            return toast(tooBigMessage(file)); // say so now, not after uploading 100 MB
          }
          if (state.files[key]) URL.revokeObjectURL(state.files[key].url);
          state.files[key] = { file, url: URL.createObjectURL(file) };
          wrap.replaceWith(mediaField(f, label));
        },
      }),
      h("div", { class: "thumb" }, preview),
      h("div", {},
        h("div", { class: "what" },
          pick ? `New ${noun}: ${pick.file.name}`
            : needsPick(f) ? `Choose a ${noun} to start`
            : !current.filename ? `No ${noun} yet`
            : state.values[key] === f.value ? `Using the ${noun} from your workflow`
            : `Your ${noun}: ${current.filename}`),
        h("div", { class: "hint" }, `Tap to choose a ${noun}`))));
  return wrap;
}

const PRETTY = {
  cfg: "CFG", batch_size: "Batch size", denoise: "Denoise", length: "Length (frames)",
  unet_name: "Model", ckpt_name: "Model", clip_name: "Text encoder", vae_name: "VAE", sampler_name: "Sampler",
};

// "color_correction_method" -> "Color correction method", "resize_type.multiplier" -> "Multiplier"
function pretty(name) {
  const last = String(name).split(".").pop();
  return PRETTY[last] || last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, " ");
}

const inputId = (f) => "f-" + fieldKey(f).replace(/\W/g, "_");

function numberField(f, label) {
  const key = fieldKey(f);
  const id = inputId(f);
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    h("input", {
      id,
      type: "number",
      inputmode: f.type === "INT" ? "numeric" : "decimal",
      step: f.step ?? (f.type === "INT" ? 1 : "any"),
      min: f.min,
      max: f.max,
      value: state.values[key] ?? "",
      oninput: (e) => { state.values[key] = e.target.value; saveValuesSoon(); },
    }));
}

function selectField(f, label) {
  const key = fieldKey(f);
  const id = inputId(f);
  const current = String(state.values[key] ?? f.value);
  const options = (f.options || []).map(String);
  if (!options.includes(current)) options.unshift(current);
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    h("select", { id, onchange: (e) => { state.values[key] = e.target.value; saveValuesSoon(); } },
      options.map((o) => h("option", { value: o, selected: o === current }, o))));
}

function toggleField(f, label) {
  const key = fieldKey(f);
  return h("div", { class: "field" },
    h("label", { class: "toggle" },
      h("input", {
        type: "checkbox", checked: Boolean(state.values[key]),
        onchange: (e) => { state.values[key] = e.target.checked; saveValuesSoon(); },
      }),
      label));
}

function stringField(f, label) {
  const key = fieldKey(f);
  const id = inputId(f);
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    h("input", {
      id, type: "text", value: state.values[key] ?? "",
      oninput: (e) => { state.values[key] = e.target.value; saveValuesSoon(); },
    }));
}

function seedField() {
  const v = state.values;
  const input = h("input", {
    id: "seed-input", type: "number", inputmode: "numeric", "aria-label": "Seed",
    value: v.seed ?? "", disabled: v.seedRandom,
    oninput: (e) => { v.seed = e.target.value; saveValuesSoon(); },
  });
  return h("div", { class: "field" },
    h("span", { class: "label" }, "Seed"),
    h("div", { class: "seed-row" },
      h("label", { class: "toggle" },
        h("input", {
          type: "checkbox", checked: v.seedRandom,
          onchange: (e) => { v.seedRandom = e.target.checked; input.disabled = v.seedRandom; saveValuesSoon(); },
        }),
        "New each run"),
      input));
}

// Servers before field groups: prompts and uploads up front, everything else under More.
const groupOf = (f) => f.group || ((f.kind === "text" && f.role === "positive") || isMedia(f) ? "main" : "more");

function fieldLabel(f, fields) {
  if (f.kind === "text") {
    const peers = fields.filter((o) => o.kind === "text" && o.role === f.role);
    return peers.length > 1 ? labelFor(f, peers) : f.role === "negative" ? "Negative prompt" : "Prompt";
  }
  if (isMedia(f)) {
    if (f.number) return `${KIND_NAMES[f.kind]} ${f.number}`; // matches <Picture 1> in prompts
    const peers = fields.filter(isMedia);
    return peers.length > 1 ? labelFor(f, peers) : KIND_NAMES[f.kind];
  }
  if (f.label) return pretty(f.label); // the name the desktop node shows
  const repeated = fields.filter((o) => o.input === f.input).length > 1;
  return pretty(f.input) + (repeated ? ` · ${f.title}` : "");
}

// Numbers sit two to a row; everything else gets a full row. All seeds share one control.
function fieldBlocks(fields, all) {
  const blocks = [];
  let row = null;
  let seedShown = false;
  for (const f of fields) {
    if (f.kind === "number") {
      if (!row) blocks.push((row = h("div", { class: "grid2" })));
      row.append(numberField(f, fieldLabel(f, all)));
      continue;
    }
    row = null;
    const label = fieldLabel(f, all);
    if (f.kind === "seed") {
      if (!seedShown) blocks.push(seedField());
      seedShown = true;
    } else if (f.kind === "text") blocks.push(textField(f, label));
    else if (isMedia(f)) blocks.push(mediaField(f, label));
    else if (f.kind === "select") blocks.push(selectField(f, label));
    else if (f.kind === "toggle") blocks.push(toggleField(f, label));
    else if (f.kind === "string") blocks.push(stringField(f, label));
  }
  return blocks;
}

function renderTemplate() {
  const t = state.current;
  const main = t.fields.filter((f) => groupOf(f) === "main");
  const more = t.fields.filter((f) => groupOf(f) === "more");

  fill(views.template,
    h("div", { class: "stage", id: "stage" }),
    fieldBlocks(main, t.fields),
    main.length === 0
      ? h("p", { class: "hint-line" }, "This workflow has no prompt or upload. It runs exactly as saved on your PC.")
      : null,
    more.length > 0
      ? h("details", { class: "more-settings", open: store.get("moreOpen", false), ontoggle: (e) => store.set("moreOpen", e.target.open) },
          h("summary", {}, "More settings"),
          h("div", { class: "inner" },
            fieldBlocks(more, t.fields),
            h("button", { class: "link-btn", type: "button", onclick: resetValues }, "Reset to the workflow's defaults")))
      : null,
    h("div", { class: "gen-bar" }, h("button", { class: "btn", id: "go", type: "button", onclick: generate }, "Generate")));
  renderStage();
}

async function showTemplate(id) {
  const known = state.templates?.find((t) => t.id === id);
  show("template", state.current?.id === id ? state.current.name : known?.name || "", true);
  if (state.current?.id === id) renderTemplate();
  else views.template.replaceChildren(h("p", { class: "hint-line" }, "Loading…"));

  try {
    const fresh = await api(`/mobile/api/templates/${encodeURIComponent(id)}`);
    // The user may have opened another template while this one loaded.
    const [page, shownId] = location.hash.replace(/^#\/?/, "").split("/");
    if (page !== "t" || decodeURIComponent(shownId || "") !== id) return;
    const changed = state.current?.id !== id || state.current.updated !== fresh.updated;
    if (!changed) return;
    state.current = fresh;
    loadValues();
    if (state.job?.templateId === id && !state.job.prompt) state.job.prompt = fresh.prompt;
    if (views.template.hidden) return;
    $("#title").textContent = fresh.name;
    renderTemplate();
  } catch (e) {
    if (state.current?.id !== id) views.template.replaceChildren(errorBox("Couldn't open this workflow", e.message));
  }
}

// ---- stage: progress and results

function runCard(job) {
  return h("div", { class: "run", id: "run" },
    h("div", { class: "preview" },
      job.previewUrl ? h("img", { id: "run-img", src: job.previewUrl, alt: "Live preview" }) : h("div", { class: "pulse", id: "run-pulse" })),
    h("div", { class: "body" },
      h("div", { class: "phase" }, h("span", { id: "run-phase" }), h("span", { class: "step", id: "run-step" })),
      h("div", { class: "bar", id: "run-bar" }, h("i")),
      h("div", { class: "times" },
        h("span", { id: "run-time" }),
        h("button", { class: "btn small danger", type: "button", onclick: cancelJob }, "Cancel"))));
}

function updateRunCard() {
  const job = state.job;
  if (!job || job.finished || !$("#run")) return;
  const d = describeJob(job);
  $("#run-phase").textContent = d.phase;
  $("#run-step").textContent = d.step;
  $("#run-time").textContent = d.time;
  const bar = $("#run-bar");
  bar.classList.toggle("indeterminate", d.fraction == null);
  bar.firstChild.style.width = `${Math.round((d.fraction ?? 0) * 100)}%`;
  if (job.previewUrl) {
    let img = $("#run-img");
    if (!img) $("#run-pulse")?.replaceWith((img = h("img", { id: "run-img", alt: "Live preview" })));
    if (img && img.src !== job.previewUrl) img.src = job.previewUrl;
  }
}

function resultItem(x) {
  if (x.kind === "text") return h("div", { class: "result" }, h("div", { class: "text" }, x.text));
  const url = viewUrl(x);
  if (x.kind === "image") {
    // A phone-sized preview; an upscaled PNG can be 20 MB. Tapping opens the full file.
    return h("a", { class: "result", href: url, target: "_blank" },
      h("img", { src: previewUrl(x), alt: x.filename, onerror: (e) => { e.target.onerror = null; e.target.src = url; } }));
  }
  if (x.kind === "video") {
    // The poster shows a frame straight away; the video itself loads only when played.
    return h("div", { class: "result" },
      h("video", { src: url, poster: thumbUrl(x, 1024), controls: true, playsinline: true, loop: true, preload: "none" }),
      h("div", { class: "row result-actions" },
        h("a", { class: "btn small secondary", href: url, target: "_blank" }, "Open to save"),
        h("a", { class: "btn small secondary", href: url, download: x.filename }, "Download")));
  }
  if (x.kind === "audio") return h("div", { class: "result" }, h("audio", { src: url, controls: true, preload: "metadata" }));
  return h("div", { class: "result" },
    h("div", { class: "file" },
      h("span", {}, x.kind === "model" ? `3D model · ${x.filename}` : x.filename),
      h("a", { class: "btn small secondary", href: url, download: x.filename }, "Download")));
}

function resultsBlock(items, line, fresh) {
  const files = items.filter((x) => x.kind !== "text").length;
  return h("div", {},
    h("div", { class: "done-line" }, fresh ? h("b", {}, line) : h("span", {}, line), h("span", {}, files > 1 ? `${files} files` : "")),
    h("div", { class: "results" }, items.length ? items.map(resultItem) : h("p", { class: "hint-line" }, "Finished, but the workflow saved no files.")),
    items.some((x) => x.kind === "image") ? h("p", { class: "hint-line" }, "Tap to open full size, then press and hold to save to Photos.") : null,
    items.some((x) => x.kind === "video") ? h("p", { class: "hint-line" }, "To keep a video: Open to save, then the share button → Save Video.") : null);
}

function renderStage() {
  const stage = $("#stage");
  const t = state.current;
  if (!stage || !t) return;
  const job = state.job;
  const mine = job && job.templateId === t.id;
  stage.replaceChildren();
  if (mine && job.finished && !views.template.hidden) job.seen = true;

  if (mine && !job.finished) {
    stage.append(runCard(job));
    updateRunCard();
  } else if (mine && job.status === "done") {
    // ComfyUI's own run time when known; the phone's clock would include time spent asleep.
    const took = job.runMs ?? job.finishedAt - (job.startedAt || job.submittedAt);
    stage.append(resultsBlock(job.outputs, `Done in ${fmtTime(took)}`, true));
  } else if (mine && job.status === "error") {
    const outOfMemory = /out of memory|exceed allowed memory/i.test(job.error || "");
    // e.g. "VAELoader: Value not in list (vae_name: 'minimax_h3_audio_vae_fp32.safetensors' not in [...])"
    const missingModel = (job.error || "").match(/Value not in list \(\w+: '([^']+\.(?:safetensors|gguf|ckpt|pt|pth|bin|sft))'/i);
    stage.append(outOfMemory
      ? errorBox("Your PC ran out of graphics memory", `Try a smaller size, then generate again.\n\n${job.error}`)
      : missingModel
        ? errorBox("A model isn't on your PC yet", `${missingModel[1]} is missing. Once it has finished downloading, generate again.`)
        : errorBox("That didn't work", job.error));
  } else if (mine && job.status === "cancelled") {
    stage.append(h("p", { class: "hint-line" }, "Cancelled."));
  } else {
    const last = store.get("last." + t.id, null);
    if (last?.items?.length) stage.append(resultsBlock(last.items, `Last result · ${ago(last.at)}`, false));
  }

  const go = $("#go");
  if (go) {
    const busyHere = mine && !job.finished;
    const busyElsewhere = job && !job.finished && !mine;
    go.disabled = Boolean(busyHere || busyElsewhere);
    go.textContent = busyHere ? "Generating…" : busyElsewhere ? `Busy with "${job.templateName}"` : mine && job.status === "done" ? "Generate again" : "Generate";
  }
}

// ---- recent

function openViewer(item) {
  const url = viewUrl(item);
  let media;
  if (item.kind === "image") media = h("img", { src: previewUrl(item), alt: item.filename });
  else if (item.kind === "video") media = h("video", { src: url, poster: thumbUrl(item, 1024), controls: true, playsinline: true, autoplay: true, loop: true });
  else if (item.kind === "audio") media = h("audio", { src: url, controls: true, autoplay: true });
  else media = h("div", {}, item.filename);
  const when = item.time ? ago(item.time) : "";

  const viewer = $("#viewer");
  fill(viewer,
    h("div", { class: "bar-top" },
      h("button", { type: "button", onclick: closeViewer }, "Close"),
      h("span", { class: "when" }, when),
      h("a", { href: url, target: "_blank" }, item.kind === "image" ? "Full size" : "Open")),
    h("div", { class: "media-wrap", onclick: (e) => e.target === e.currentTarget && closeViewer() }, media),
    item.caption ? h("div", { class: "caption" }, item.caption) : null);
  viewer.hidden = false;
}

function closeViewer() {
  const viewer = $("#viewer");
  viewer.hidden = true;
  viewer.replaceChildren();
}

const BADGES = { video: "VIDEO", audio: "AUDIO", model: "3D", file: "FILE" };

function recentTile(item) {
  const inner = item.kind === "image" || item.kind === "video"
    ? h("img", { src: thumbUrl(item), alt: "", loading: "lazy", onerror: (e) => e.target.replaceWith(icon(item.kind)) })
    : icon(item.kind);
  return h("button", { class: "tile", type: "button", "aria-label": item.filename, onclick: () => openViewer(item) },
    inner,
    item.kind !== "image" ? h("span", { class: "badge" }, BADGES[item.kind] || "FILE") : null);
}

const RECENT_PAGE = 60;

// The newest files in ComfyUI's output folder, so Recent survives ComfyUI restarts.
async function loadRecent(more) {
  const r = state.recent;
  const query = new URLSearchParams({ limit: RECENT_PAGE, offset: more ? r.items.length : 0 });
  if (r.kind !== "all") query.set("kind", r.kind);
  try {
    const page = await api(`/mobile/api/recent?${query}`);
    const items = page.items.map((item) => ({ ...item, kind: kindOf(item.filename) }));
    r.items = more ? [...r.items, ...items] : items;
    r.total = page.total;
    r.kinds = page.kinds;
    if (!views.recent.hidden) renderRecent();
  } catch (e) {
    if (e.status === 404) return loadRecentFromHistory(); // server older than this page
    if (!r.items.length) views.recent.replaceChildren(errorBox("Couldn't load recent results", e.message));
    else toast(e.message);
  }
}

// Before /mobile/api/recent existed: what ComfyUI made since it started, from its history.
async function loadRecentFromHistory() {
  const r = state.recent;
  try {
    const history = await api("/history?max_items=60");
    const items = [];
    for (const entry of Object.values(history).reverse()) {
      for (const item of outputsOf(entry.outputs)) if (FILE_CATEGORY[item.kind]) items.push(item);
    }
    r.kinds = {};
    for (const item of items) r.kinds[FILE_CATEGORY[item.kind]] = (r.kinds[FILE_CATEGORY[item.kind]] || 0) + 1;
    r.items = r.kind === "all" ? items : items.filter((item) => FILE_CATEGORY[item.kind] === r.kind);
    r.total = r.items.length;
    if (!views.recent.hidden) renderRecent();
  } catch (e) {
    views.recent.replaceChildren(errorBox("Couldn't load recent results", e.message));
  }
}

function renderRecent() {
  const r = state.recent;
  const present = CATEGORIES.filter((c) => r.kinds[c.key]);
  const all = Object.values(r.kinds).reduce((a, b) => a + b, 0);
  fill(views.recent,
    present.length > 1
      ? segmented([["all", "All", all], ...present.map((c) => [c.key, c.files, r.kinds[c.key]])], r.kind, (key) => {
          r.kind = key;
          store.set("recentKind", key);
          r.items = [];
          views.recent.replaceChildren(h("p", { class: "hint-line" }, "Loading…"));
          loadRecent(false);
        })
      : null,
    r.items.length
      ? h("div", { class: "recent-grid" }, r.items.map(recentTile))
      : h("div", { class: "empty" },
          h("h2", {}, "Nothing yet"),
          h("p", {}, "What you make, on the phone or on the PC, shows up here.")),
    r.items.length < r.total
      ? h("button", {
          class: "btn secondary load-more", type: "button",
          onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Loading…"; loadRecent(true); },
        }, `Show more (${r.total - r.items.length})`)
      : null);
}

async function showRecent() {
  show("recent", "Recent", false);
  if (state.recent.items.length) renderRecent();
  else views.recent.replaceChildren(h("p", { class: "hint-line" }, "Loading…"));
  await loadRecent(false);
}

// ------------------------------------------------------------ start

$("#conn").addEventListener("click", () => toast(conn.open ? "Connected to your PC" : "Trying to reach your PC…"));
$("#back").addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // iOS freezes the page; a socket left behind can look open on return yet be dead. Close it
    // cleanly now and open a fresh one when the page comes back.
    recycleSocket();
    return;
  }
  document.title = "Comfy Mobile";
  connect();
  syncJob();
  if (!views.home.hidden) showHome();
});

const savedJob = store.get("job", null);
if (savedJob?.promptId) {
  state.job = newJob(null, null, { ...savedJob, status: "queued" });
  startTicker();
}
connect();
route();
