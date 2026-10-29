"""Phone templates built only from models already installed:
Z-Image Turbo (+ qwen_3_4b, ae VAE), BiRefNet and SeedVR2 7B.

Restyling a whole photo with Z-Image Turbo image-to-image was tested and left out:
below denoise ~0.55 the style doesn't show, above it the person's face and the
room layout change. The "Edit" templates use FLUX.2 Klein 4B instead
(flux-2-klein-4b-fp8 + flux2-vae, 4.4 GB, sharing qwen_3_4b with Z-Image).

    python edit_templates.py                      # write the API-format JSON files next to this script
    python edit_templates.py --install URL        # also add them to the phone, e.g. http://127.0.0.1:8188
    python edit_templates.py --install URL "Upscale photo"   # only the named ones

The JSON files can also be dragged into ComfyUI to open them as a normal workflow.
"""

import argparse
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def node(class_type, title=None, **inputs):
    return {"class_type": class_type, "inputs": inputs, "_meta": {"title": title or class_type}}


def z_image(prompt):
    """Shared Z-Image Turbo loaders and prompt encoding."""
    return {
        "50": node("UNETLoader", "Load Diffusion Model", unet_name="z_image_turbo_bf16.safetensors", weight_dtype="default"),
        "51": node("CLIPLoader", "Load CLIP", clip_name="qwen_3_4b.safetensors", type="lumina2", device="default"),
        "52": node("VAELoader", "Load VAE", vae_name="ae.safetensors"),
        "53": node("ModelSamplingAuraFlow", shift=3, model=["50", 0]),
        "54": node("CLIPTextEncode", "Prompt", text=prompt, clip=["51", 0]),
        "55": node("ConditioningZeroOut", conditioning=["54", 0]),
    }


def sampler(latent, model, denoise=1.0, steps=8):
    return node("KSampler", seed=0, steps=steps, cfg=1, sampler_name="res_multistep", scheduler="simple",
                denoise=denoise, model=[model, 0], positive=["54", 0], negative=["55", 0], latent_image=latent)


def photo(image):
    return {
        "1": node("LoadImage", "Photo", image=image),
        "2": node("ImageScaleToTotalPixels", "Resize to 1 MP", image=["1", 0], upscale_method="lanczos",
                  megapixels=1.0, resolution_steps=16),
    }


def remove_background(image="portrait_model_denim.png"):
    """Photo in, transparent PNG out, at the photo's full size."""
    return {
        "1": node("LoadImage", "Photo", image=image),
        "10": node("LoadBackgroundRemovalModel", bg_removal_name="birefnet.safetensors"),
        "11": node("RemoveBackground", "Find the subject", bg_removal_model=["10", 0], image=["1", 0]),
        "12": node("InvertMask", mask=["11", 0]),
        "13": node("JoinImageWithAlpha", image=["1", 0], alpha=["12", 0]),
        "8": node("SaveImage", filename_prefix="mobile/no-background", images=["13", 0]),
    }


def new_background(image="portrait_model_denim.png",
                   prompt="standing on a sunny beach at golden hour, palm trees, soft warm light, shallow depth of field"):
    """Keep the subject pixel-for-pixel; Z-Image paints a new background around it."""
    nodes = {**z_image(prompt), **photo(image)}
    nodes.update({
        "56": node("DifferentialDiffusion", model=["53", 0]),
        "10": node("LoadBackgroundRemovalModel", bg_removal_name="birefnet.safetensors"),
        "11": node("RemoveBackground", "Find the subject", bg_removal_model=["10", 0], image=["2", 0]),
        "12": node("InvertMask", mask=["11", 0]),
        # Let the new background reach a few pixels under the subject's edge, so no old background shows there.
        "13": node("GrowMask", mask=["12", 0], expand=8, tapered_corners=True),
        "3": node("VAEEncode", pixels=["2", 0], vae=["52", 0]),
        "14": node("SetLatentNoiseMask", samples=["3", 0], mask=["13", 0]),
        "6": sampler(["14", 0], "56", denoise=1.0),
        "7": node("VAEDecode", samples=["6", 0], vae=["52", 0]),
        "15": node("ImageCompositeMasked", "Put the subject back", destination=["7", 0], source=["2", 0],
                   x=0, y=0, resize_source=False, mask=["11", 0]),
        "8": node("SaveImage", filename_prefix="mobile/new-background", images=["15", 0]),
    })
    return nodes


def upscale(image="portrait_model_denim.png", megapixels=8.0):
    """SeedVR2 upscale to a set output size. A size instead of a multiplier, because phone photos
    are already large: 4x of a 3.7 MP photo is 59 MP and runs out of GPU memory. On the RTX 5060
    (8 GB) 8 MP takes ~25 s and 16 MP (the resize node's maximum) ~45 s."""
    tiled = dict(tile_size=512, overlap=128, temporal_size=4096, temporal_overlap=8)
    return {
        "1": node("LoadImage", "Photo", image=image),
        "50": node("JoinImageWithAlpha", image=["1", 0], alpha=["1", 1]),
        "57": node("ResizeImageMaskNode", "Output size", input=["50", 0], scale_method="lanczos",
                   resize_type="scale total pixels", **{"resize_type.megapixels": megapixels}),
        "58": node("SeedVR2Preprocess", resized_images=["57", 0]),
        "51": node("VAELoader", vae_name="seedvr2_ema_vae_fp16.safetensors"),
        "52": node("UNETLoader", unet_name="seedvr2_7b_int8_convrot.safetensors", weight_dtype="default"),
        "48": node("VAEEncodeTiled", pixels=["58", 0], vae=["51", 0], **tiled),
        "61": node("SeedVR2Conditioning", model=["52", 0], vae_conditioning=["48", 0]),
        "54": node("KSampler", seed=0, steps=1, cfg=1, sampler_name="euler", scheduler="simple", denoise=1,
                   model=["52", 0], positive=["61", 0], negative=["61", 1], latent_image=["48", 0]),
        "55": node("VAEDecodeTiled", samples=["54", 0], vae=["51", 0], **tiled),
        "59": node("SeedVR2PostProcessing", images=["55", 0], original_resized_images=["57", 0],
                   color_correction_method="lab"),
        "9": node("SaveImage", filename_prefix="mobile/upscaled", images=["59", 0]),
    }


def klein(instruction):
    """FLUX.2 Klein 4B (distilled, 4 steps). Reuses Z-Image's qwen_3_4b text encoder."""
    return {
        "70": node("UNETLoader", "Load Diffusion Model", unet_name="flux-2-klein-4b-fp8.safetensors", weight_dtype="default"),
        "71": node("CLIPLoader", "Load CLIP", clip_name="qwen_3_4b.safetensors", type="flux2", device="default"),
        "72": node("VAELoader", "Load VAE", vae_name="flux2-vae.safetensors"),
        "74": node("CLIPTextEncode", "Instruction", text=instruction, clip=["71", 0]),
        "82": node("ConditioningZeroOut", conditioning=["74", 0]),
        "61": node("KSamplerSelect", sampler_name="euler"),
        "73": node("RandomNoise", noise_seed=0),
    }


def klein_sample(nodes, positive, negative, size_from, prefix):
    """Sample at the size of `size_from` (the first photo after resizing) and save."""
    nodes.update({
        "99": node("GetImageSize", image=[size_from, 0]),
        "63": node("CFGGuider", model=["70", 0], positive=[positive, 0], negative=[negative, 0], cfg=1),
        "62": node("Flux2Scheduler", steps=4, width=["99", 0], height=["99", 1]),
        "66": node("EmptyFlux2LatentImage", width=["99", 0], height=["99", 1], batch_size=1),
        "64": node("SamplerCustomAdvanced", noise=["73", 0], guider=["63", 0], sampler=["61", 0], sigmas=["62", 0],
                   latent_image=["66", 0]),
        "65": node("VAEDecode", samples=["64", 0], vae=["72", 0]),
        "9": node("SaveImage", filename_prefix=prefix, images=["65", 0]),
    })
    return nodes


def edit_photo(image="portrait_model_denim.png", instruction="Change the sweater color to red.", megapixels=1.0):
    """Edit a photo by instruction: "make it night", "add sunglasses", "remove the cup"."""
    nodes = klein(instruction)
    nodes.update({
        "1": node("LoadImage", "Photo", image=image),
        "80": node("ImageScaleToTotalPixels", "Output size", image=["1", 0], upscale_method="lanczos",
                   megapixels=megapixels, resolution_steps=16),
        "122": node("VAEEncode", pixels=["80", 0], vae=["72", 0]),
        "123": node("ReferenceLatent", conditioning=["74", 0], latent=["122", 0]),
        "121": node("ReferenceLatent", conditioning=["82", 0], latent=["122", 0]),
    })
    return klein_sample(nodes, "123", "121", "80", "mobile/edited")


def edit_with_reference(image="portrait_model_denim.png", reference="clothing_light_blue_denim_shirt.png",
                        instruction="Dress the man in image 1 in the shirt from image 2.", megapixels=1.0):
    """Edit the first photo using a second one: a garment, a logo, a style, a background."""
    nodes = klein(instruction)
    nodes.update({
        "1": node("LoadImage", "Photo", image=image),
        "2": node("LoadImage", "Second photo", image=reference),
        "80": node("ImageScaleToTotalPixels", "Output size", image=["1", 0], upscale_method="lanczos",
                   megapixels=megapixels, resolution_steps=16),
        "85": node("ImageScaleToTotalPixels", image=["2", 0], upscale_method="lanczos", megapixels=1.0,
                   resolution_steps=16),
        "122": node("VAEEncode", pixels=["80", 0], vae=["72", 0]),
        "124": node("VAEEncode", pixels=["85", 0], vae=["72", 0]),
        "123": node("ReferenceLatent", conditioning=["74", 0], latent=["122", 0]),
        "125": node("ReferenceLatent", conditioning=["123", 0], latent=["124", 0]),
        "121": node("ReferenceLatent", conditioning=["82", 0], latent=["122", 0]),
        "126": node("ReferenceLatent", conditioning=["121", 0], latent=["124", 0]),
    })
    return klein_sample(nodes, "125", "126", "80", "mobile/edited")


OUTPUT_SIZE = [{"node": "80", "input": "megapixels", "label": "Output size (megapixels)"}]

# name: (build, settings the phone shows; None lets the phone pick by input names)
TEMPLATES = {
    "Remove background": (remove_background, None),
    "New background": (new_background, None),
    "Upscale photo": (upscale, [
        {"node": "57", "input": "resize_type.megapixels", "label": "Output size (megapixels)"},
        {"node": "59", "input": "color_correction_method", "label": "Color correction"},
    ]),
    "Edit photo": (edit_photo, OUTPUT_SIZE),
    "Edit with 2 photos": (edit_with_reference, OUTPUT_SIZE),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", metavar="URL", help="ComfyUI address to add the templates to")
    parser.add_argument("names", nargs="*", help="only these templates (default: all)")
    args = parser.parse_args()
    for name, (build, settings) in TEMPLATES.items():
        if args.names and name not in args.names:
            continue
        prompt = build()
        path = os.path.join(HERE, name.lower().replace(" ", "-") + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(prompt, f, indent=2)
        print("wrote", path)
        if args.install:
            body = json.dumps({"name": name, "prompt": prompt, "settings": settings}).encode()
            req = urllib.request.Request(args.install.rstrip("/") + "/mobile/api/templates", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as res:
                saved = json.load(res)
            print(f"  installed as {saved['id']}" + (f"  (warning: {saved['warning']})" if saved.get("warning") else ""))


if __name__ == "__main__":
    main()
