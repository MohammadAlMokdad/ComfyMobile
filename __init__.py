"""Comfy Mobile: a phone-friendly page for running saved ComfyUI workflows.

The ComfyUI desktop UI gets a "Send to phone" button (web/send_to_phone.js).
It saves the open workflow, in API format, as a template. The phone page at
/mobile lists the templates and shows only the inputs worth touching: the
prompt, any image/video/audio to upload, and the settings the desktop shows on
subgraph nodes (technical ones under "More settings").
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from io import BytesIO

from aiohttp import web
from PIL import Image, ImageOps

import execution
import folder_paths
import nodes
from server import PromptServer

APP_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "app")
TEMPLATES_DIR = os.path.join(folder_paths.get_user_directory(), "default", "comfy-mobile")

WEB_DIRECTORY = "./web"
# The phone page updates as soon as its files change, the server only when ComfyUI restarts.
# app.js asks for this and asks for a restart when the server is older than it needs.
API_VERSION = 4
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

SAMPLER_ROLES = ("positive", "negative")
SEED_INPUTS = {"seed", "noise_seed"}
SETTING_INPUTS = ["width", "height", "batch_size", "length", "seconds", "steps", "cfg", "denoise"]
# Promoted settings that still go under "More settings" on the phone.
TECHNICAL_INPUTS = {"steps", "cfg", "sampler_name", "scheduler", "denoise", "weight_dtype", "device", "type", "shift"}
TECHNICAL_WORDS = re.compile(r"steps?\b|cfg|sampler|scheduler|denoise|shift|strength|multiple\b|dtype|device", re.IGNORECASE)
MODEL_FILE = re.compile(r"\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$", re.IGNORECASE)
# Nodes that only hold a value for the user to pick, like "Float (Duration)" or an aspect-ratio picker.
KNOB_NODES = re.compile(r"^(Primitive(Int|Float|Boolean|String|StringMultiline)|ResolutionSelector)$")
GENERIC_NAME = re.compile(r"^value(_\d+)?$")
# Multi-line text that is code, not a prompt (e.g. ComfyMathExpression turning seconds into frames).
# Whole input names and specific node names only: "code" alone would also match CLIPTextEncode.
NOT_PROMPT_INPUT = re.compile(r"^(expression|formula|code|script|regex|pattern)$", re.IGNORECASE)
NOT_PROMPT_NODE = re.compile(r"MathExpression|Formula|Regex", re.IGNORECASE)
PASS_THROUGH = {("ComfySwitchNode", "on_true"), ("ComfySwitchNode", "on_false")}
VIDEO_FILE = re.compile(r"\.(mp4|webm|mov|mkv|m4v)$", re.IGNORECASE)
FILE_KINDS = [
    ("photo", re.compile(r"\.(png|jpe?g|webp|gif|avif|bmp)$", re.IGNORECASE)),
    ("video", VIDEO_FILE),
    ("audio", re.compile(r"\.(wav|mp3|flac|ogg|opus|m4a|aac)$", re.IGNORECASE)),
    ("3d", re.compile(r"\.(glb|gltf|obj|ply|stl|usdz)$", re.IGNORECASE)),
]
# What a template makes, from the class of its output nodes. Checked in this order.
OUTPUT_CATEGORIES = [
    ("video", re.compile(r"video|animat", re.IGNORECASE)),
    ("audio", re.compile(r"audio|music|speech", re.IGNORECASE)),
    ("3d", re.compile(r"3d|mesh|glb|gltf", re.IGNORECASE)),
]
RECENT_MAX = 200
UPLOAD_KINDS = {"image_upload": "image", "video_upload": "video", "audio_upload": "audio"}
MEDIA_KINDS = set(UPLOAD_KINDS.values())
UPSTREAM_DEPTH = 8
SUBGRAPH_DEPTH = 6
MAX_OPTIONS = 500
THUMB_SIZE = 384


# ---------------------------------------------------------------- fields

def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[1], int)


def _input_specs(class_type):
    """{input name: (type, options)} for a node class, or {} if unknown."""
    cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
    if cls is None:
        return {}
    try:
        types = cls.INPUT_TYPES()
    except Exception as e:
        logging.warning(f"[comfy-mobile] INPUT_TYPES failed for {class_type}: {e}")
        return {}
    specs = {}
    for section in ("required", "optional"):
        for name, spec in (types.get(section) or {}).items():
            if isinstance(spec, (list, tuple)) and spec:
                options = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                specs[name] = (spec[0], options)
    return specs


def _distances_from(prompt, start):
    """Hops from `start` to every node upstream of it."""
    dist, frontier = {}, [str(start)]
    for hops in range(UPSTREAM_DEPTH):
        next_frontier = []
        for node_id in frontier:
            if node_id in dist or node_id not in prompt:
                continue
            dist[node_id] = hops
            for value in prompt[node_id].get("inputs", {}).values():
                if _is_link(value):
                    next_frontier.append(str(value[0]))
        frontier = next_frontier
    return dist


def _text_roles(prompt):
    """Map node id -> "positive" / "negative" by the nearest sampler input it feeds.

    A negative branch often starts from the positive text (ConditioningZeroOut),
    so the closer input wins and ties go to positive.
    """
    best = {}
    for node in prompt.values():
        for role in SAMPLER_ROLES:
            link = node.get("inputs", {}).get(role)
            if not _is_link(link):
                continue
            for node_id, hops in _distances_from(prompt, link[0]).items():
                current = best.get(node_id)
                if current is None or hops < current[1] or (hops == current[1] and role == "positive"):
                    best[node_id] = (role, hops)
    return {node_id: role for node_id, (role, _) in best.items()}


def _input_spec(class_type, name, inputs):
    """(type, options) for one input. Dotted names ("resize_type.multiplier") are
    inputs of a dynamic combo's chosen option."""
    specs = _input_specs(class_type)
    if name in specs:
        return specs[name]
    parent, _, child = name.partition(".")
    if not child or parent not in specs:
        return None
    for choice in specs[parent][1].get("options") or []:
        if isinstance(choice, dict) and choice.get("key") == inputs.get(parent):
            for section in ("required", "optional"):
                spec = ((choice.get("inputs") or {}).get(section) or {}).get(child)
                if isinstance(spec, (list, tuple)) and spec:
                    return spec[0], spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    return None


def _field_kind(name, value_type, options):
    upload = next((kind for key, kind in UPLOAD_KINDS.items() if options.get(key)), None)
    if upload:
        return upload
    if isinstance(value_type, (list, tuple)) or value_type == "COMBO":
        return "select"
    if value_type == "STRING":
        return "text" if options.get("multiline") else "string"
    if value_type == "INT" and name in SEED_INPUTS:
        return "seed"
    if value_type in ("INT", "FLOAT"):
        return "number"
    if value_type == "BOOLEAN":
        return "toggle"
    return None


def _add_details(field, value_type, options):
    if field["kind"] in ("number", "seed"):
        # Seeds too: some nodes only take 32-bit seeds, and a random one above max fails validation.
        field["type"] = value_type
        for key in ("min", "max", "step"):
            if key in options:
                field[key] = options[key]
    elif field["kind"] == "select":
        choices = value_type if isinstance(value_type, (list, tuple)) else options.get("options") or []
        field["options"] = [c for c in choices if isinstance(c, (str, int, float))][:MAX_OPTIONS]


def _is_technical(field):
    if field["kind"] == "seed" or field["input"] in TECHNICAL_INPUTS or field.get("technical"):
        return True
    if TECHNICAL_WORDS.search(field.get("label") or ""):
        return True
    choices = [field["value"], *field.get("options", [])]
    return field["kind"] == "select" and any(MODEL_FILE.search(str(o)) for o in choices)


def _mark_technical(field, consumers):
    """A value that ends up in steps, cfg... goes under More, named after what it sets:
    "Int (Full)" feeding the scheduler's steps through a switch becomes "Full · steps"."""
    technical = [n for n in _feeds(consumers, field["node"]) if n in TECHNICAL_INPUTS]
    if technical:
        field["technical"] = True
        if technical[0].lower() not in field["label"].lower():
            field["label"] = f"{field['label']} · {technical[0]}"


def _is_output(class_type):
    try:
        return bool(getattr(nodes.NODE_CLASS_MAPPINGS.get(class_type), "OUTPUT_NODE", False))
    except Exception:
        return False


def _reachable(prompt):
    """Nodes that feed an output node. ComfyUI runs only these, so only their settings matter."""
    stack = [node_id for node_id, node in prompt.items() if _is_output(node.get("class_type"))]
    if not stack:
        return set(prompt)
    seen = set()
    while stack:
        node_id = str(stack.pop())
        if node_id in seen or node_id not in prompt:
            continue
        seen.add(node_id)
        stack.extend(str(v[0]) for v in prompt[node_id].get("inputs", {}).values() if _is_link(v))
    return seen


def _consumers(prompt):
    """node id -> [(consumer id, consumer class, input name)] for every link out of it."""
    found = {}
    for node_id, node in prompt.items():
        for name, value in node.get("inputs", {}).items():
            if _is_link(value):
                found.setdefault(str(value[0]), []).append((node_id, node.get("class_type"), name))
    return found


def _feeds(consumers, node_id, depth=4, follow_all=False):
    """Input names a node's output ends up in. Follows switches that only pass the value on,
    or every node with `follow_all`."""
    names, frontier = [], [node_id]
    for _ in range(depth):
        next_frontier = []
        for current in frontier:
            for consumer, consumer_class, name in consumers.get(current, []):
                names.append(name)
                if follow_all or (consumer_class, name) in PASS_THROUGH:
                    next_frontier.append(consumer)
        frontier = next_frontier
    return names


def _title_label(title, class_type):
    """"Float (Duration)" -> "Duration"; None when the title is just the node's default name."""
    match = re.search(r"\(([^()]+)\)\s*$", title or "")
    if match:
        return match.group(1).strip()
    return None if title in (class_type, nodes.NODE_DISPLAY_NAME_MAPPINGS.get(class_type)) else title


def _number_media(media, consumers):
    """Several uploads with the same title become Photo 1, Photo 2... in the order the workflow
    takes them (ref_images.image_1 before image_2), matching prompts that say <Picture 1>."""
    if len(media) < 2 or len({f["title"] for f in media}) == len(media):
        return media

    def slot(field):
        for name in _feeds(consumers, field["node"], depth=3, follow_all=True):
            digits = re.findall(r"\d+", name)
            if digits:
                return int(digits[-1])
        return 1_000_000

    media = sorted(media, key=slot)
    for number, field in enumerate(media, 1):
        field["number"] = number
    return media


def describe_fields(prompt, promoted=None, only_promoted=False):
    """The inputs the phone shows, in display order, each with group "main" or "more".

    `promoted` is what the desktop UI shows on subgraph nodes (see promoted_inputs).
    When it is known, a setting inside a subgraph is shown only if it is promoted,
    so the phone offers the same settings as the desktop. With `only_promoted`
    (templates that list their settings explicitly) that applies to every node.
    Prompts, uploads and seeds are always included, wherever they are. Settings of
    nodes that feed no output are left out: ComfyUI doesn't run those.
    """
    roles = _text_roles(prompt)
    reachable = _reachable(prompt)
    consumers = _consumers(prompt)
    order = {(p["node"], p["input"]): i for i, p in enumerate(promoted or [])}
    labels = {(p["node"], p["input"]): p["label"] for p in promoted or []}
    prompts, media, settings, knobs, negatives, extra = [], [], [], [], [], []
    for node_id, node in prompt.items():
        if node_id not in reachable:
            continue
        class_type = node.get("class_type", "")
        title = (node.get("_meta") or {}).get("title") or class_type
        inputs = node.get("inputs", {})
        for name, value in inputs.items():
            if _is_link(value):
                continue
            spec = _input_spec(class_type, name, inputs)
            kind = spec and _field_kind(name, *spec)
            if not kind:
                continue
            field = {"node": node_id, "input": name, "title": title, "value": value, "kind": kind}
            _add_details(field, *spec)
            key = (node_id, name)
            if kind in MEDIA_KINDS:
                # The workflow's own file may not be here (e.g. a template's sample picture), and then
                # the phone must ask for one instead of letting the run fail.
                try:
                    field["missing"] = not folder_paths.exists_annotated_filepath(str(value))
                except Exception:
                    field["missing"] = False
                media.append(field)
            elif kind == "text":
                if NOT_PROMPT_INPUT.search(name) or NOT_PROMPT_NODE.search(class_type):
                    continue
                field["role"] = "negative" if roles.get(node_id) == "negative" else "positive"
                (negatives if field["role"] == "negative" else prompts).append(field)
            elif key in order:
                label = labels[key]
                field["label"] = (_title_label(title, class_type) or label) if GENERIC_NAME.match(label) else label
                _mark_technical(field, consumers)
                settings.append(field)
            elif kind == "seed":
                # Even when hidden in a subgraph: the desktop still randomizes it, and an unchanged
                # seed makes ComfyUI return the cached result instead of a new image.
                extra.append(field)
            elif promoted is not None and (only_promoted or ":" in node_id):
                continue  # not one of the settings the template shows
            elif KNOB_NODES.match(class_type):
                single = len(_input_specs(class_type)) == 1
                field["label"] = (_title_label(title, class_type) if single else None) or name
                _mark_technical(field, consumers)
                knobs.append(field)
            elif kind == "number" and name in SETTING_INPUTS:
                if name == "denoise" and isinstance(value, (int, float)) and value >= 1:
                    continue  # full denoise is text-to-image; the setting only means something below 1
                extra.append(field)

    settings.sort(key=lambda f: order[(f["node"], f["input"])])
    settings += knobs
    media = _number_media(media, consumers)
    extra.sort(key=lambda f: (f["kind"] == "seed", SETTING_INPUTS.index(f["input"]) if f["kind"] == "number" else 0))
    main = prompts + media + [f for f in settings if not _is_technical(f)]
    more = negatives + [f for f in settings if _is_technical(f)] + extra
    for f in main:
        f["group"] = "main"
    for f in more:
        f["group"] = "more"
    return main + more


# ---------------------------------------------------------------- subgraphs

def _link_targets(links):
    """link id -> (target node id, target slot). Subgraph links are dicts, top-level ones lists."""
    targets = {}
    for link in links or []:
        if isinstance(link, dict):
            targets[link.get("id")] = (link.get("target_id"), link.get("target_slot"))
        elif isinstance(link, list) and len(link) >= 5:
            targets[link[0]] = (link[3], link[4])
    return targets


def _widget_input(node, slot):
    """Widget name of a node's input slot, or None if that slot is a plain socket."""
    try:
        slot_info = (node or {}).get("inputs", [])[slot]
    except (IndexError, TypeError):
        return None
    return (slot_info.get("widget") or {}).get("name")


def _widget_inputs_of(subgraph):
    """Older workflows promote a widget by wiring a subgraph input to it."""
    nodes_by_id = {str(n.get("id")): n for n in subgraph.get("nodes") or []}
    targets = _link_targets(subgraph.get("links"))
    for sg_input in subgraph.get("inputs") or []:
        for link_id in sg_input.get("linkIds") or []:
            target_id, slot = targets.get(link_id, (None, None))
            if _widget_input(nodes_by_id.get(str(target_id)), slot):
                yield sg_input.get("name")
                break


def promoted_inputs(workflow):
    """The settings shown on subgraph nodes in the desktop UI, in display order, as
    [{node: flattened prompt id like "66:57", input, label}]. None without a workflow."""
    if not isinstance(workflow, dict):
        return None
    subgraphs = {sg.get("id"): sg for sg in (workflow.get("definitions") or {}).get("subgraphs") or []}

    def resolve(subgraph, inner_id, widget, path, depth):
        """Follow a promoted widget down to the node input it really controls."""
        if depth > SUBGRAPH_DEPTH:
            return None
        nodes_by_id = {str(n.get("id")): n for n in subgraph.get("nodes") or []}
        if str(inner_id) == "-1":  # the widget of a subgraph input
            sg_input = next((i for i in subgraph.get("inputs") or [] if i.get("name") == widget), {})
            targets = _link_targets(subgraph.get("links"))
            for link_id in sg_input.get("linkIds") or []:
                target_id, slot = targets.get(link_id, (None, None))
                name = _widget_input(nodes_by_id.get(str(target_id)), slot)
                if name:
                    return resolve(subgraph, target_id, name, path, depth)
            return None
        node = nodes_by_id.get(str(inner_id))
        if node is None:
            return None
        nested = subgraphs.get(node.get("type"))
        if nested is None:
            return f"{path}:{inner_id}", widget
        for entry in (node.get("properties") or {}).get("proxyWidgets") or []:
            if isinstance(entry, list) and len(entry) >= 2 and entry[1] == widget:
                return resolve(nested, entry[0], entry[1], f"{path}:{inner_id}", depth + 1)
        return resolve(nested, "-1", widget, f"{path}:{inner_id}", depth + 1)

    found, seen = [], set()
    for node in workflow.get("nodes") or []:
        subgraph = subgraphs.get(node.get("type"))
        if subgraph is None:
            continue
        labels = {i.get("name"): i["label"] for i in subgraph.get("inputs") or [] if i.get("label")}
        for slot in node.get("inputs") or []:
            widget = (slot.get("widget") or {}).get("name")
            if widget and slot.get("label"):
                labels[widget] = slot["label"]
        # proxyWidgets is what the node shows; without it, the widgets wired to subgraph inputs are.
        entries = [tuple(e[:2]) for e in (node.get("properties") or {}).get("proxyWidgets") or []
                   if isinstance(e, list) and len(e) >= 2]
        if not entries:
            entries = [("-1", name) for name in _widget_inputs_of(subgraph)]
        for inner_id, widget in entries:
            resolved = resolve(subgraph, inner_id, widget, str(node.get("id")), 0)
            if resolved and resolved not in seen:
                seen.add(resolved)
                found.append({"node": resolved[0], "input": resolved[1], "label": labels.get(widget) or widget})
    return found


# ---------------------------------------------------------------- storage

def _template_path(template_id):
    if not re.fullmatch(r"[a-z0-9-]{1,80}", template_id or ""):
        raise web.HTTPBadRequest(text="bad template id")
    return os.path.join(TEMPLATES_DIR, template_id + ".json")


def _load_templates():
    templates = []
    if not os.path.isdir(TEMPLATES_DIR):
        return templates
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(TEMPLATES_DIR, filename), encoding="utf-8") as f:
                templates.append(json.load(f))
        except (OSError, ValueError) as e:
            logging.warning(f"[comfy-mobile] skipping {filename}: {e}")
    templates.sort(key=lambda t: t.get("updated", 0), reverse=True)
    return templates


def _new_id(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return f"{slug}-{uuid.uuid4().hex[:6]}" if slug else uuid.uuid4().hex[:12]


def _save_template(template):
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    path = _template_path(template["id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------- routes

routes = PromptServer.instance.routes


@routes.get("/mobile")
async def mobile_redirect(request):
    raise web.HTTPFound("/mobile/")


@routes.get("/mobile/")
async def mobile_index(request):
    return web.FileResponse(os.path.join(APP_DIR, "index.html"), headers={"Cache-Control": "no-store"})


routes.static("/mobile/app", APP_DIR)


@routes.get("/mobile/api/version")
async def version(request):
    # The upload limit lets the phone refuse an oversized video before sending 100 MB for nothing.
    from comfy.cli_args import args
    return web.json_response({"version": API_VERSION, "max_upload_mb": args.max_upload_size})


# Fields are worked out on every read, so improvements to describe_fields reach templates saved earlier.

def _fields_of(template):
    return describe_fields(template.get("prompt") or {}, template.get("promoted"), template.get("only_promoted", False))


def _category(prompt):
    """"video", "audio", "3d" or "photo": what the template makes, judged by its output nodes."""
    outputs = [n.get("class_type", "") for n in prompt.values() if _is_output(n.get("class_type"))]
    for category, pattern in OUTPUT_CATEGORIES:
        if any(pattern.search(c) for c in outputs):
            return category
    return "photo"


def _prompt_text(prompt):
    """The positive prompt of a finished job, for captions in Recent."""
    best = ("", -2)
    for node in (prompt or {}).values():
        if not isinstance(node, dict) or NOT_PROMPT_NODE.search(node.get("class_type", "")):
            continue
        title = (node.get("_meta") or {}).get("title", "")
        score = -1 if re.search(r"negative", title, re.IGNORECASE) else 1 if re.search(r"positive|prompt", title, re.IGNORECASE) else 0
        for name, value in (node.get("inputs") or {}).items():
            if isinstance(value, str) and name in ("text", "prompt", "value") and len(value.split()) > 2 and score >= 0:
                if (score, len(value)) > (best[1], len(best[0])):
                    best = (value.strip(), score)
    return best[0]


def _scan_outputs():
    """Every image/video/audio/3D file in the output folder, newest first."""
    base = folder_paths.get_output_directory()
    found = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        subfolder = os.path.relpath(root, base).replace("\\", "/")
        subfolder = "" if subfolder == "." else subfolder
        for name in files:
            kind = next((k for k, pattern in FILE_KINDS if pattern.search(name)), None)
            if kind is None:
                continue
            try:
                mtime = os.path.getmtime(os.path.join(root, name))
            except OSError:
                continue
            found.append({"filename": name, "subfolder": subfolder, "type": "output", "kind": kind, "time": int(mtime * 1000)})
    found.sort(key=lambda f: f["time"], reverse=True)
    return found


def _history_captions():
    """(subfolder, filename) -> prompt text, for jobs still in ComfyUI's history."""
    captions = {}
    try:
        history = PromptServer.instance.prompt_queue.get_history(max_items=RECENT_MAX)
    except Exception:
        return captions
    for entry in history.values():
        text = _prompt_text((entry.get("prompt") or [None, None, {}])[2])
        if not text:
            continue
        for out in (entry.get("outputs") or {}).values():
            for items in out.values():
                for item in items if isinstance(items, list) else []:
                    if isinstance(item, dict) and item.get("filename"):
                        captions[(item.get("subfolder") or "", item["filename"])] = text
    return captions


def _summaries():
    summary = []
    for t in _load_templates():
        try:
            summary.append({"id": t.get("id"), "name": t.get("name"), "updated": t.get("updated"),
                            "fields": _fields_of(t), "category": _category(t.get("prompt") or {})})
        except Exception as e:  # one odd template shouldn't hide all the others
            logging.warning(f"[comfy-mobile] skipping template {t.get('name')}: {e}")
    return summary


@routes.get("/mobile/api/templates")
async def list_templates(request):
    # Off the event loop: describing fields calls every node's INPUT_TYPES, and some list folders.
    return web.json_response(await asyncio.to_thread(_summaries))


@routes.get("/mobile/api/recent")
async def recent(request):
    """A page of the newest output files, from the output folder so it survives ComfyUI restarts.
    ?kind=photo|video|audio|3d filters; captions come from jobs still in ComfyUI's history."""
    query = request.rel_url.query
    try:
        limit = max(1, min(int(query.get("limit", 60)), RECENT_MAX))
        offset = max(0, int(query.get("offset", 0)))
    except ValueError:
        raise web.HTTPBadRequest(text="limit and offset must be numbers")
    files = await asyncio.to_thread(_scan_outputs)
    kinds = {}
    for f in files:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    if query.get("kind"):
        files = [f for f in files if f["kind"] == query["kind"]]
    page = files[offset:offset + limit]
    captions = _history_captions()
    for f in page:
        f["caption"] = captions.get((f["subfolder"], f["filename"]), "")
    return web.json_response({"items": page, "total": len(files), "kinds": kinds})


@routes.get("/mobile/api/templates/{id}")
async def get_template(request):
    path = _template_path(request.match_info["id"])
    if not os.path.isfile(path):
        raise web.HTTPNotFound(text="template not found")
    with open(path, encoding="utf-8") as f:
        template = json.load(f)
    template["fields"] = await asyncio.to_thread(_fields_of, template)
    template["category"] = _category(template.get("prompt") or {})
    return web.json_response(template)


@routes.post("/mobile/api/templates")
async def save_template(request):
    body = await request.json()
    name = str(body.get("name") or "").strip()[:80]
    prompt = body.get("prompt")
    if not name:
        raise web.HTTPBadRequest(text="name is required")
    if not isinstance(prompt, dict) or not prompt or not all(isinstance(n, dict) and "class_type" in n for n in prompt.values()):
        raise web.HTTPBadRequest(text="prompt must be a workflow in API format")

    # Saving under an existing name replaces that template, so re-sending an edited workflow updates it.
    existing = next((t for t in _load_templates() if t.get("name", "").lower() == name.lower()), None)
    # Scripts can list the settings to show; the desktop button sends its workflow instead.
    settings = body.get("settings")
    explicit = isinstance(settings, list) and all(isinstance(s, dict) and "node" in s and "input" in s for s in settings)
    template = {
        "id": existing["id"] if existing else _new_id(name),
        "name": name,
        "updated": int(time.time() * 1000),
        "prompt": prompt,
        "promoted": [{"node": str(s["node"]), "input": str(s["input"]), "label": str(s.get("label") or s["input"])}
                     for s in settings] if explicit else promoted_inputs(body.get("workflow")),
        "only_promoted": explicit,
    }
    _save_template(template)
    fields = _fields_of(template)

    warning = None
    try:
        valid = await execution.validate_prompt(str(uuid.uuid4()), prompt, None)
        if not valid[0]:
            warning = (valid[1] or {}).get("message") or "ComfyUI reports a problem with this workflow."
            node_error = next(iter((valid[3] or {}).values()), None)
            if node_error and node_error.get("errors"):
                first = node_error["errors"][0]
                warning = f"{node_error.get('class_type')}: {first.get('message')} ({first.get('details')})"
    except Exception as e:
        logging.warning(f"[comfy-mobile] could not validate {name}: {e}")

    return web.json_response({"id": template["id"], "name": name, "replaced": existing is not None,
                              "fields": fields, "warning": warning})


@routes.delete("/mobile/api/templates/{id}")
async def delete_template(request):
    path = _template_path(request.match_info["id"])
    if os.path.isfile(path):
        os.remove(path)
    return web.json_response({"deleted": True})


def _video_frame(path, skip=12):
    """A frame from the start of a video; a few frames in, since many videos open on black."""
    import av

    with av.open(path) as container:
        frame = None
        for index, frame in enumerate(container.decode(video=0)):
            if index >= skip:
                break
        if frame is None:
            raise ValueError("no video frames")
        return frame.to_image()


@routes.get("/mobile/api/thumb")
async def thumbnail(request):
    """A small JPEG of an output/input image or video, so the Recent grid stays light on mobile data."""
    query = request.rel_url.query
    base = folder_paths.get_directory_by_type(query.get("type", "output"))
    if base is None:
        raise web.HTTPBadRequest(text="bad type")
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, os.path.normpath(query.get("subfolder", "")), query.get("filename", "")))
    try:
        inside = os.path.commonpath((base, path)) == base
    except ValueError:  # another drive or a UNC path
        inside = False
    if not inside or not os.path.isfile(path):
        raise web.HTTPNotFound()
    try:
        size = max(64, min(int(query.get("size", THUMB_SIZE)), 2048))
    except ValueError:
        size = THUMB_SIZE

    def render():
        img = _video_frame(path) if VIDEO_FILE.search(path) else ImageOps.exif_transpose(Image.open(path))
        with img:
            img.thumbnail((size, size))
            buf = BytesIO()
            img.convert("RGB").save(buf, "JPEG", quality=80)
            return buf.getvalue()

    try:
        body = await asyncio.to_thread(render)
    except Exception:  # not an image, or a video PyAV can't decode
        raise web.HTTPUnsupportedMediaType()
    return web.Response(body=body, content_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})
