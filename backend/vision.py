"""
Picture check: one BLURRED frame goes to a vision AI, which must answer each
question by picking one of the given options. "Not clearly visible" is always
allowed. The AI never writes free text into the findings.
"""

import base64
import json

import requests

import settings

NOT_VISIBLE = "Not clearly visible"

GENERIC_OPTIONS = [
    {"label": "Looks fine", "means": "ok"},
    {"label": "Shows a possible problem", "means": "issue"},
]


def configured():
    return bool(settings.get("LLM_API_KEY"))


def questions_for(items):
    """Turns checklist 'look for' items into fixed-option questions."""
    out = []
    for it in items:
        if it.get("kind") != "look_for":
            continue
        v = it.get("vision") or {}
        options = v.get("options") or GENERIC_OPTIONS
        out.append({
            "item_id": it["id"],
            "question": v.get("question") or it["text"],
            "options": options + [{"label": NOT_VISIBLE, "means": "unclear"}],
        })
    return out


def check(jpeg_bytes, questions, areas):
    """Returns {"area": str, "answers": {item_id: {"option", "means"}}} or raises."""
    payload = {
        "area_options": areas + ["Unclear"],
        "questions": [{"id": q["item_id"], "question": q["question"],
                       "options": [o["label"] for o in q["options"]]} for q in questions],
    }
    prompt = (
        "You are checking ONE photo taken during a company site visit. Faces are blurred on purpose.\n"
        "1. Pick the area shown, from area_options.\n"
        "2. For each question, pick exactly one option, copied word for word. "
        "If the photo does not clearly show the answer, pick '" + NOT_VISIBLE + "'. "
        "Never guess. Most questions will not apply to a given photo.\n"
        "Reply with JSON only: {\"area\": \"...\", \"answers\": {\"<id>\": \"<option>\"}}\n\n"
        + json.dumps(payload)
    )
    image = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode("ascii")
    res = requests.post(
        settings.get("LLM_BASE_URL").rstrip("/") + "/chat/completions",
        headers={"Authorization": "Bearer " + settings.get("LLM_API_KEY")},
        json={
            "model": settings.get("LLM_MODEL"),
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image}},
            ]}],
        },
        timeout=45,
    )
    res.raise_for_status()
    raw = json.loads(res.json()["choices"][0]["message"]["content"])

    area = raw.get("area") if raw.get("area") in areas else "Unclear"
    answers = {}
    for q in questions:
        picked = (raw.get("answers") or {}).get(q["item_id"])
        match = next((o for o in q["options"] if o["label"] == picked), None)
        if match is None:  # anything outside the fixed options counts as not visible
            match = q["options"][-1]
        answers[q["item_id"]] = {"option": match["label"], "means": match["means"]}
    return {"area": area, "answers": answers}
