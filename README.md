# Comfy Mobile

A phone-friendly page for running your ComfyUI workflows. The phone shows only the prompt, the photo, video or audio to upload, a progress bar with time left, and the result. Everything else stays in ComfyUI on the PC.

```
ComfyUI on the PC                              Phone (e.g. over Tailscale)
  "Send to phone" button ──saves──▶ template ──▶ http://<your-pc>:8188/mobile/
                                                  prompt / photo → Generate → progress → result
```

It is a ComfyUI custom node, so it runs inside ComfyUI. There is no separate server to start and no build step.

## Features

- **Send to phone** button in ComfyUI that saves the open workflow as a phone template. Sending again with the same name updates it.
- The phone works out which inputs to show from the workflow: prompt, uploads, and the settings shown on grouped (subgraph) nodes.
- Live progress from ComfyUI's websocket: upload progress, current stage, sampler steps, a live preview, elapsed time and time left.
- Runs survive the phone locking. A pill on other screens shows the current run and tells you when it's ready.
- Home screen groups workflows into Photo, Video, Audio and 3D tools, with the usual run time on each card.
- **Recent** tab lists the newest files in ComfyUI's output folder (from the phone or the PC), filterable by type, with phone-sized thumbnails.
- Installable as a home-screen web app (web app manifest + icon).
- Optional script that builds ready-made photo templates (edit, upscale, remove or replace background).

## Requirements

- A recent ComfyUI install (Desktop, portable or manual) with the current ComfyUI frontend.
- No extra Python packages. The node uses `aiohttp`, `Pillow` and `av` (PyAV, for video thumbnails), which ship with ComfyUI.
- To use it away from the PC, a private network between the phone and the PC, such as [Tailscale](https://tailscale.com/).

## Install

1. Clone into ComfyUI's `custom_nodes` folder:

   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/MohammadAlMokdad/ComfyMobile.git
   ```

   If you'd rather keep the repo elsewhere, link it in instead. On Windows:

   ```powershell
   New-Item -ItemType Junction -Path "<ComfyUI>\custom_nodes\ComfyMobile" -Target "<path-to>\ComfyMobile"
   ```

2. Restart ComfyUI.
3. Open `http://127.0.0.1:8188/mobile/` on the PC to check it loads.

## Reach it from your phone

By default ComfyUI listens only on `127.0.0.1`. To reach it from your phone over Tailscale, have it listen on the PC's Tailscale address too:

```bash
python main.py --listen 127.0.0.1,<your-tailscale-ip>
```

On ComfyUI Desktop, add the same `--listen` value to its server launch settings. Allow ComfyUI's Python through the firewall if your OS asks.

Then, with Tailscale on, open `http://<your-tailscale-ip>:8188/mobile/` on the phone. In Safari, Share → **Add to Home Screen** makes it open like an app.

## Use it

1. **On the PC:** open a workflow in ComfyUI and click **Send to phone**, the phone icon in the top bar. It's also under **Workflow** in the menu and in the canvas right-click menu. Give it a name. ComfyUI validates the workflow and warns you if it may not run.
2. **On the phone:** pick a workflow, type a prompt or choose a photo, and tap **Generate**. You can cancel a run, and download or open the result.
3. To remove a workflow from the phone, tap **⋯** on its card. It stays in ComfyUI on the PC.

Templates are saved as JSON in `ComfyUI/user/default/comfy-mobile/`.

## What the phone shows

| Shown | Comes from |
|---|---|
| **Prompt** | Multi-line text inputs that feed a sampler's `positive` input |
| **Photo / Video / Audio** | Load Image / Load Video / Load Audio nodes. If you don't pick one, the workflow's own file is used. If that file isn't on the PC, the phone asks for one. |
| **Settings on grouped nodes** | Exactly the settings shown on a subgraph node in ComfyUI, with the same names: the node's `proxyWidgets`, or, in older workflows, the widgets wired to the subgraph's inputs. Settings kept inside the group don't appear. |
| **Value nodes** | Top-level Primitive and resolution-picker nodes, labelled from their titles (e.g. "Float (Duration)" becomes "Duration"). |
| **More settings** | Negative prompt; technical settings (sampler, scheduler, steps, CFG, denoise, model files); seed. For nodes outside groups: width, height, batch size, steps, CFG, and denoise when it's below 1. |

Nodes that don't feed an output are skipped, since ComfyUI doesn't run them. To change what the phone shows for a grouped node, change which settings the node shows in ComfyUI and click **Send to phone** again.

The seed is new on each run unless you untick **New each run**. The field always shows the seed the last run used, so you can lock it to repeat a result.

Time left is estimated from the step rate and from how long this workflow usually takes.

## Ready-made templates

`templates/edit_templates.py` builds phone templates for photo editing. Timings were measured on an RTX 5060 Laptop GPU (8 GB):

| Template | Model | Time |
|---|---|---|
| **Edit photo**: an instruction like "make the sweater red" or "remove the plant" | FLUX.2 Klein 4B | ~15 s at 1 MP |
| **Edit with 2 photos**: "dress the man in image 1 in the shirt from image 2" | FLUX.2 Klein 4B | ~20 s |
| **Upscale photo**: output size in megapixels, up to 16 | SeedVR2 7B | ~25 s at 8 MP |
| **Remove background**: transparent PNG | BiRefNet | ~3 s |
| **New background**: keeps the subject, paints a new scene | BiRefNet + Z-Image Turbo | ~30 s |

The templates expect these model files in your ComfyUI models folders:

| Template | Model files |
|---|---|
| Edit photo, Edit with 2 photos | `flux-2-klein-4b-fp8.safetensors`, `flux2-vae.safetensors`, `qwen_3_4b.safetensors` |
| Upscale photo | `seedvr2_7b_int8_convrot.safetensors`, `seedvr2_ema_vae_fp16.safetensors` |
| Remove background | `birefnet.safetensors` |
| New background | `birefnet.safetensors`, `z_image_turbo_bf16.safetensors`, `qwen_3_4b.safetensors`, `ae.safetensors` |

```bash
python templates/edit_templates.py                                          # write the API-format JSON files
python templates/edit_templates.py --install http://127.0.0.1:8188          # also add them all to the phone
python templates/edit_templates.py --install http://127.0.0.1:8188 "Edit photo"   # add or update one
```

`templates/desktop/` has the same workflows in ComfyUI's normal (UI) format, so you can open them on the desktop. To remake one after changing the script, drag its `templates/*.json` file onto the ComfyUI canvas and save it.

## HTTP routes

All routes are added to ComfyUI's own server.

| Route | Purpose |
|---|---|
| `GET /mobile/` | The phone page (`/mobile/app/*` serves its files) |
| `GET /mobile/api/version` | API version and ComfyUI's upload size limit |
| `GET`, `POST /mobile/api/templates` | List templates, or save one (`name`, `prompt` in API format, and `workflow` or an explicit `settings` list) |
| `GET`, `DELETE /mobile/api/templates/{id}` | Read a template with its fields, or remove it |
| `GET /mobile/api/recent` | Newest output files, with `kind`, `limit` and `offset` |
| `GET /mobile/api/thumb` | A small JPEG of an image or video in the output or input folder |

## Project structure

```
__init__.py               Server routes and field detection (what the phone shows)
web/send_to_phone.js      The "Send to phone" button inside ComfyUI
web/hide_assets_tab.js    Hides ComfyUI's Assets sidebar tab (see below)
app/                      The phone page: plain HTML, CSS and JS, no build step
templates/                Ready-made templates and the script that builds them
templates/desktop/        The same templates in ComfyUI's UI format
```

Changes to `app/` need only a page reload on the phone. Changes to `__init__.py` or `web/` need a ComfyUI restart. If the phone page is newer than the server part, it shows a banner asking you to restart ComfyUI.

## Assets tab

The node also hides the **Assets** tab in ComfyUI's left sidebar, since it lists every generated and imported image, including everything made from the phone. To show it again, turn off **Settings → Comfy Mobile → Hide the Assets tab**.

## Security

ComfyUI has no login. This page has the same access as the ComfyUI UI, so only make it reachable over a private network like Tailscale. Listen on `127.0.0.1` and your Tailscale address rather than `0.0.0.0`, and don't expose it with port forwarding or a public tunnel.
