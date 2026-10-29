// Hides the Assets tab in ComfyUI's left sidebar: it lists every generated and imported image,
// including everything the phone makes. Settings → Comfy Mobile → "Hide the Assets tab" brings it back.
import { app } from "../../scripts/app.js";

const SETTING = "ComfyMobile.HideAssetsTab";
const TAB_ID = "assets";
let savedTab = null; // the removed tab, to put back when the setting is turned off

function sidebar() {
  return app.extensionManager?.sidebarTab;
}

// Returns false while the sidebar isn't ready yet (or the tab hasn't been added yet).
function apply(hide) {
  const store = sidebar();
  if (!store?.sidebarTabs) return false;
  const tab = store.sidebarTabs.find((t) => t.id === TAB_ID);
  if (hide) {
    if (!tab) return false;
    savedTab = tab;
    store.unregisterSidebarTab(TAB_ID);
  } else if (!tab && savedTab) {
    store.registerSidebarTab(savedTab);
  }
  return true;
}

app.registerExtension({
  name: "ComfyMobile.HideAssetsTab",
  settings: [
    {
      id: SETTING,
      category: ["Comfy Mobile", "Sidebar", "Hide the Assets tab"],
      name: "Hide the Assets tab",
      tooltip: "The Assets tab lists every generated and imported image. Turn this off to show it again.",
      type: "boolean",
      defaultValue: true,
      onChange: (hide) => apply(hide),
    },
  ],
  setup() {
    // ComfyUI adds its own sidebar tabs around the time extensions start, so keep trying briefly.
    let tries = 0;
    const timer = setInterval(() => {
      const hide = app.extensionManager?.setting?.get(SETTING) ?? true;
      if (!hide || apply(true) || ++tries > 40) clearInterval(timer);
    }, 250);
  },
});
