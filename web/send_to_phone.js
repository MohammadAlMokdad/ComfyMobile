// Adds "Send to phone" to the ComfyUI desktop UI: it saves the open workflow
// as a Comfy Mobile template, so it shows up on the phone page at /mobile.
import { app } from "../../scripts/app.js";

const COMMAND_ID = "ComfyMobile.SendToPhone";

function toast(severity, summary, detail) {
  const toasts = app.extensionManager?.toast;
  if (toasts) toasts.add({ severity, summary, detail, life: severity === "error" ? 8000 : 5000 });
  else alert(`${summary}\n${detail ?? ""}`);
}

async function askName(defaultValue) {
  const dialog = app.extensionManager?.dialog;
  if (dialog?.prompt) {
    return dialog.prompt({
      title: "Send to phone",
      message: "Name shown on your phone (same name replaces the old one):",
      defaultValue,
    });
  }
  return window.prompt("Name shown on your phone:", defaultValue);
}

function describe(fields) {
  const count = (kind) => fields.filter((f) => f.kind === kind).length;
  const parts = [];
  if (fields.some((f) => f.kind === "text" && f.role === "positive")) parts.push("prompt");
  for (const kind of ["image", "video", "audio"]) {
    const n = count(kind);
    if (n) parts.push(n > 1 ? `${n} ${kind}s` : kind);
  }
  const settings = fields.filter((f) => f.label).map((f) => f.label);
  const asks = parts.length ? `Phone will ask for: ${parts.join(", ")}.` : "No prompt or upload found; it will run as saved.";
  return settings.length ? `${asks} Settings: ${settings.join(", ")}.` : asks;
}

async function sendToPhone() {
  if (!app.graph?.nodes?.length) {
    toast("warn", "Nothing to send", "Open a workflow first. The canvas is empty.");
    return;
  }
  const active = app.extensionManager?.workflow?.activeWorkflow;
  const fallback = (active?.filename || active?.path || "Untitled").replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
  const name = (await askName(fallback))?.trim();
  if (!name) return;

  try {
    // The workflow tells the server which settings the subgraph nodes show, so the phone can match.
    const { output, workflow } = await app.graphToPrompt();
    const res = await fetch("/mobile/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt: output, workflow }),
    });
    if (!res.ok) throw new Error(await res.text());
    const saved = await res.json();
    toast("success", `${saved.replaced ? "Updated" : "Sent"} "${saved.name}"`, describe(saved.fields));
    if (saved.warning) toast("warn", "It may not run yet", saved.warning);
  } catch (err) {
    toast("error", "Could not send to phone", String(err.message || err));
  }
}

app.registerExtension({
  name: COMMAND_ID,
  commands: [{ id: COMMAND_ID, label: "Send to phone", icon: "pi pi-mobile", function: sendToPhone }],
  menuCommands: [{ path: ["Workflow"], commands: [COMMAND_ID] }],
  actionBarButtons: [
    { icon: "pi pi-mobile", label: "Send to phone", tooltip: "Save this workflow to the phone app", onClick: sendToPhone },
  ],
  getCanvasMenuItems() {
    return [null, { content: "Send to phone", callback: sendToPhone }];
  },
});
