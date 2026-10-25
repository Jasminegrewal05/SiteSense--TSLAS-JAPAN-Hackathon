"""
Phase 3 matching: for every warning sign that fired in Phase 1, put three things side by side.

  Said     what the company side said about it (claims from the visit transcript)
  Numbers  the confirmed number behind the sign, with its source (cell or page)
  Seen     the analyst's own ticks, accepted suggestions, then picture checks

Fixed rules only, no AI. The result is a list of finding cards. The analyst keeps or
removes each one; only kept cards reach the report.

Verdicts:
  differs     something disagrees (what was said vs the numbers, or vs what was seen)
  not_shown   the place this sign depends on was never shown, and nothing was seen
  supported   at least one check agrees and none disagree
  unchecked   nothing to compare
"""

import re

# ---------- reading amounts out of a sentence ----------

ONES = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
        "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
        "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
        "ek": 1, "teen": 3, "chaar": 4, "paanch": 5, "panch": 5, "chhe": 6, "saat": 7, "aath": 8, "nau": 9,
        "das": 10, "bees": 20, "pachaas": 50, "half": 0.5, "aadha": 0.5, "dedh": 1.5,
        "dhai": 2.5}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
        "ninety": 90}
SCALES = {"hundred": 100, "sau": 100, "thousand": 1000, "hazaar": 1000, "hazar": 1000}

PCT_WORDS = ("percent", "per cent", "%", "pratishat", "percentage")
DAY_WORDS = ("day", "days", "din")
MONTH_WORDS = ("month", "months", "mahine", "mahina")
COUNT_WORDS = ("people", "workers", "employees", "staff", "headcount", "persons", "log", "manpower")
CRORE_WORDS = ("crore", "cr", "crores")
LAKH_WORDS = ("lakh", "lakhs", "lac")

_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?|%|[a-z]+")


def _words_to_numbers(tokens):
    """Turns number words into numbers: ['ninety', 'five', 'percent'] -> [95, 'percent']."""
    out, cur, active = [], 0.0, False
    for tok in tokens + ["<end>"]:
        if tok in ONES:
            cur += ONES[tok]
            active = True
        elif tok in TENS:
            cur += TENS[tok]
            active = True
        elif tok in SCALES and active:
            cur *= SCALES[tok]
        elif tok == "and" and active:
            continue
        else:
            if active:
                out.append(cur)
                cur, active = 0.0, False
            if tok != "<end>":
                out.append(tok)
    return out


def amounts(text):
    """
    Every amount in a sentence with its unit: pct, days, count, cr, or plain.
    "about ninety percent" -> [(90, 'pct')]; "two months" -> [(60, 'days')];
    "400 lakh" -> [(4.0, 'cr')]; "around 380 workers" -> [(380, 'count')].
    """
    raw = _TOKEN.findall(text.lower().replace("per cent", "percent"))
    tokens = []
    for t in raw:
        if t[0].isdigit():
            tokens.append(float(t.replace(",", "")))
        else:
            tokens.append(t)
    tokens = _words_to_numbers([t if isinstance(t, str) else str(t) for t in tokens])
    tokens = [float(t) if isinstance(t, str) and re.fullmatch(r"\d+(\.\d+)?", t) else t for t in tokens]
    out = []
    for i, t in enumerate(tokens):
        if not isinstance(t, float):
            continue
        nxt = [x for x in tokens[i + 1:i + 3] if isinstance(x, str)]
        unit = "plain"
        if nxt and nxt[0] in PCT_WORDS:
            unit = "pct"
        elif any(w in DAY_WORDS for w in nxt[:1]):
            unit = "days"
        elif any(w in MONTH_WORDS for w in nxt[:1]):
            t, unit = t * 30, "days"
        elif any(w in CRORE_WORDS for w in nxt[:1]):
            unit = "cr"
        elif any(w in LAKH_WORDS for w in nxt[:1]):
            t, unit = t / 100.0, "cr"
        elif any(w in COUNT_WORDS for w in nxt):
            unit = "count"
        out.append((round(t, 2), unit))
    return out


def _has_phrase(text, phrases):
    low = text.lower()
    return next((p for p in phrases if re.search(r"\b" + re.escape(p.lower()) + r"\b", low)), None)


def compare_said(text, rule_compare, figure):
    """
    One sentence against the confirmed number. Returns (result, detail):
    result is 'agrees', 'differs' or 'explanation' (nothing to compare).
    """
    if not rule_compare or figure is None:
        return "explanation", ""
    unit = rule_compare.get("unit", "plain")
    target = figure.get(rule_compare.get("field", "current"))
    if target is not None:
        for value, u in amounts(text):
            if u != unit and not (unit == "count" and u == "plain" and _has_phrase(text, COUNT_WORDS)):
                continue
            if unit == "pct":
                ok = abs(value - target) <= 5
            else:
                ok = target and abs(value - target) / abs(target) <= 0.10
            shown = _fmt(value, unit)
            return ("agrees", "said " + shown + ", report " + _fmt(target, unit)) if ok else \
                   ("differs", "said " + shown + ", report " + _fmt(target, unit))
    report_level = rule_compare.get("report_level")
    hi = _has_phrase(text, rule_compare.get("said_high", []))
    lo = _has_phrase(text, rule_compare.get("said_low", []))
    if report_level and (hi or lo):
        level, phrase = ("high", hi) if hi and not lo else ("low", lo)
        if level == report_level:
            return "agrees", "\"" + phrase + "\" matches the report"
        return "differs", "\"" + phrase + "\" does not match the report"
    return "explanation", ""


def _fmt(v, unit):
    v = int(v) if float(v).is_integer() else round(v, 1)
    return {"pct": str(v) + "%", "days": str(v) + " days", "cr": "Rs " + str(v) + " cr",
            "count": str(v)}.get(unit, str(v))


# ---------- the cards ----------

def build(checklist, metrics, rules, capture):
    """
    checklist: Phase 1 checklist.json (signals, items with ticks, places)
    metrics:   Phase 1 metrics.json (derived numbers)
    rules:     rules.yaml, for the compare: blocks
    capture:   dict of Phase 2 results: claims, cues, notes, suggestions, people, places,
               kept_pieces, analyst_name (any can be empty when there was no recording)
    """
    derived = (metrics or {}).get("derived", {})
    by_rule = {r["id"]: r for r in rules.get("rules", [])}
    items = checklist["items"]
    kept = set(capture.get("kept_pieces") or [])
    names = {p["id"]: (p.get("name") or p.get("label")) for p in capture.get("people", [])}
    named_by_tap = {p["id"] for p in capture.get("people", []) if p.get("named_by") == "asking_now" or p.get("name")}
    places = {p["name"]: p for p in (capture.get("places") or {}).get("places", [])}
    listed_places = {p["name"] for p in checklist.get("places", [])}

    def clip(piece, time):
        return {"piece": piece, "time": time} if piece in kept else None

    cards = []
    for sig in checklist["signals"]:
        rule = by_rule.get(sig["id"], {})
        cmp_ = rule.get("compare")
        mine = [it for it in items if it.get("signal_id") == sig["id"]]
        ids = {it["id"] for it in mine}
        figure = derived.get(cmp_["metric"]) if cmp_ else None

        # ---- said ----
        said_lines = []
        for c in capture.get("claims", []):
            if not ids & set(c.get("items", [])):
                continue
            result, detail = compare_said(c["text"], cmp_, figure)
            if c.get("unclear") and result != "explanation":
                # the speech model was unsure of these words and nobody checked them: not proof
                detail = (detail + "; " if detail else "") + "words may be wrong, play the clip"
                result = "explanation"
            said_lines.append({
                "text": c["text"], "speaker": c["speaker"],
                "speaker_name": names.get(c["speaker"], "Unknown speaker"),
                "sure": c["sure"], "named": c["speaker"] in named_by_tap,
                "time": c["time"], "clip": clip(c["piece"], c["time"]),
                "result": result, "detail": detail, "unclear": bool(c.get("unclear")),
                "corrected": bool(c.get("corrected")),
            })
        results = {x["result"] for x in said_lines}
        said_status = ("differs" if "differs" in results else "agrees" if "agrees" in results
                       else "explanation" if said_lines else "none")

        # ---- seen ----
        look = [it for it in mine if it["kind"] == "look_for"]
        hand = [it for it in look if it.get("marked_by") == "manual" and it["status"] in ("ok", "issue")]
        accepted = [it for it in look if it.get("marked_by") == "suggestion" and it["status"] in ("ok", "issue")]
        votes = {"ok": 0, "issue": 0}
        seen_clips = []
        for nt in capture.get("notes", []):
            for iid, ans in nt.get("answers", {}).items():
                if iid in ids and ans["means"] in votes:
                    votes[ans["means"]] += 1
                    c = clip(nt["piece"], nt["time"])
                    if c and ans["means"] == "issue":
                        seen_clips.append(c)
        if hand:
            seen_status = "against" if any(it["status"] == "issue" for it in hand) else "supports"
            seen_by = "your tick"
        elif accepted:
            seen_status = "against" if any(it["status"] == "issue" for it in accepted) else "supports"
            seen_by = "accepted suggestion"
        elif votes["ok"] or votes["issue"]:
            seen_status = "against" if votes["issue"] >= votes["ok"] else "supports"
            seen_by = "pictures"
        else:
            seen_status, seen_by = "none", ""
        # Places this sign depends on that were never shown
        need = sorted({it["area"] for it in look if it["area"] in listed_places})
        missing = [p for p in need if places.get(p, {}).get("seconds", 0) == 0] if capture.get("places") else []
        all_missing = bool(need) and len(missing) == len(need)

        # ---- verdict ----
        if said_status == "differs" or seen_status == "against":
            verdict = "differs"
        elif all_missing and seen_status == "none":
            verdict = "not_shown"
        elif said_status == "agrees" or seen_status == "supports":
            verdict = "supported"
        else:
            verdict = "unchecked"

        # ---- confidence, with its reason ----
        proofs = []
        if said_status in ("agrees", "differs"):
            proofs.append("what was said vs the report")
        if seen_status != "none":
            proofs.append(seen_by)
        best_said = max(said_lines, key=lambda x: (x["sure"] == "high" or x["named"], x["result"] != "explanation"),
                        default=None)
        speaker_sure = bool(best_said and (best_said["sure"] == "high" or best_said["named"]))
        if len(proofs) >= 2 and (speaker_sure or not said_lines):
            confidence = "high"
        elif proofs:
            confidence = "medium"
        else:
            confidence = "low"
        reason = ", ".join(proofs) if proofs else ("not shown: " + ", ".join(missing) if all_missing else "no proof found")
        if said_lines and not speaker_sure:
            reason += "; speaker not confirmed"

        cards.append({
            "signal_id": sig["id"], "title": sig["signal"], "severity": sig["severity"],
            "why": sig["evidence"], "figures": sig.get("figures", []), "sources": sig.get("sources", []),
            "said": {"status": said_status, "lines": said_lines},
            "seen": {"status": seen_status, "by": seen_by, "votes": votes, "clips": seen_clips[:3],
                     "ticks": [{"id": it["id"], "text": it["text"], "status": it["status"], "note": it.get("note", ""),
                                "by": it.get("marked_by")} for it in hand + accepted],
                     "not_shown": missing},
            "cues": [{"type": q["type"], "text": q["text"], "clip": clip(q["piece"], q["time"])}
                     for q in capture.get("cues", []) if ids & set(q.get("items", []))],
            "verdict": verdict, "confidence": confidence, "reason": reason,
        })

    order = {"differs": 0, "not_shown": 1, "supported": 2, "unchecked": 3}
    sev = {"high": 0, "medium": 1, "low": 2}
    cards.sort(key=lambda c: (order[c["verdict"]], sev.get(c["severity"], 9)))
    for i, c in enumerate(cards, start=1):
        c["id"] = "F" + str(i).zfill(2)
    return cards
