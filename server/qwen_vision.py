"""
In-process Qwen2-VL via Hugging Face Transformers (local Mac / notebook prototyping).

https://huggingface.co/Qwen/Qwen2-VL-7B-Instruct
"""
from __future__ import annotations

import base64
import io
import os
from functools import lru_cache

import torch
from PIL import Image
from qwen_vl_utils import process_vision_info
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

DEFAULT_MODEL = "Qwen/Qwen2-VL-7B-Instruct"


def _model_id() -> str:
    return (
        os.environ.get("MALEX_MODEL")
        or os.environ.get("SNAPFIX_VISION_MODEL")
        or DEFAULT_MODEL
    ).strip()


def _resolve_device() -> str:
    override = (os.environ.get("SNAPFIX_VISION_DEVICE") or "").strip().lower()
    if override in ("cuda", "mps", "cpu"):
        return override

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _decode_image_b64(image_b64: str) -> Image.Image:
    raw = image_b64.strip()
    if raw.startswith("data:"):
        comma = raw.find(",")
        if comma >= 0:
            raw = raw[comma + 1 :]
    data = base64.b64decode(raw, validate=False)
    return Image.open(io.BytesIO(data)).convert("RGB")


@lru_cache(maxsize=1)
def _load_stack() -> tuple[Qwen2VLForConditionalGeneration, AutoProcessor, str]:
    model_id = _model_id()
    device = _resolve_device()
    print(f"[+] Loading {model_id} on {device} (Transformers) …")

    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        model_id,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    )
    model = model.to(device)
    model.eval()

    processor = AutoProcessor.from_pretrained(model_id)
    print(f"[+] Qwen2-VL ready ({device}).")
    return model, processor, device


def preload() -> None:
    _load_stack()


def analyze_image(
    *,
    system_prompt: str,
    user_text: str,
    image_b64: str,
    max_new_tokens: int = 512,
) -> str:
    model, processor, device = _load_stack()

    image = _decode_image_b64(image_b64)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": user_text},
            ],
        }
    ]
    if system_prompt.strip():
        messages.insert(0, {"role": "system", "content": system_prompt.strip()})

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    image_inputs, video_inputs = process_vision_info(messages)
    inputs = processor(
        text=[text],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    )
    if device in ("mps", "cuda"):
        inputs = inputs.to(device)

    with torch.inference_mode():
        generated_ids = model.generate(**inputs, max_new_tokens=max_new_tokens)

    generated_ids_trimmed = [
        out_ids[len(in_ids) :] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
    ]
    output_text = processor.batch_decode(
        generated_ids_trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )
    return output_text[0] if output_text else ""
