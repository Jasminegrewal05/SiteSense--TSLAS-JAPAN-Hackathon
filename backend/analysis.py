"""
Runs once, right after the visit ends. Turns the raw first-pass data into:

  transcript.json   every sentence with WHO said it, HOW we know, and HOW SURE
  people.json       Person 1, Person 2 ... (named by the analyst in review)
  claims.json       what the company side said about checklist topics
  cues.json         neutral cues: no number given, vague words, long pause
  suggestions.json  suggested ticks from pictures and conversation (analyst decides)

Who said it, decided in this order (first match wins):
  0. shorter than 1.5 s                                   -> unsure
  1. loud (right at the mic) and sounds like the analyst  -> analyst      (high)
  2. a face on camera moves its lips with the sound       -> that person  (high, "seen speaking")
  3. sounds like the analyst                              -> analyst      (medium)
  4. sounds like someone already SEEN speaking            -> that person  (medium, "voice match")
  5. none of the above                                    -> unknown, with possible people listed

People are told apart by VOICE over time. Faces are only used in the moment
("this face is talking now"); no face fingerprints are ever made or stored.

Pieces are 10 seconds long, so a sentence can be cut in two at a piece boundary.
merge_broken() joins those halves back into one sentence before anything else runs.
The phone also overlaps pieces by about half a second, so no word is lost in the cut;
words heard twice in that overlap are removed here.
"""

import re
from statistics import median

import capture_store as cs
import pipeline
import storage
import voice

MIN_SECONDS = 1.5
UNCLEAR_LOGPROB = -0.6   # below this, the speech model was not sure of its words
LOUD_MARGIN_DB = 6.0
SIM_ANALYST_STRONG = 0.70
SIM_ANALYST = 0.80
SIM_PERSON = 0.75

QUESTION_START = {"how", "what", "why", "when", "which", "who", "where", "can", "could", "do", "does",
                  "did", "is", "are", "will", "would", "have", "has", "was", "were", "should"}
NUMBER_ASK = ("how many", "how much", "what percent", "what percentage", "how long", "what is the number",
              "how big", "what share")
# English and common Hindi (Hinglish) number words. "do" (two) is left out: it is also an English word.
NUMBER_WORDS = ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
                "twelve", "fifteen", "twenty", "thirty", "forty", "fifty", "hundred", "thousand", "lakh",
                "crore", "half", "double", "percent", "single", "dozen",
                "ek", "teen", "chaar", "paanch", "panch", "chhe", "saat", "aath", "nau", "das", "bees",
                "pachaas", "sau", "hazaar", "hazar", "aadha", "dedh", "dhai", "pratishat", "percentage")
VAGUE = ("roughly", "more or less", "approximately", "i think", "i guess", "probably", "sort of",
         "kind of", "have to check", "not sure", "can't say", "cannot say", "difficult to say",
         "hard to say", "working on it", "get back to you", "as such", "should be", "around about",
         "lagbhag", "shayad", "kareeb", "takreeban", "dekhna padega", "check karke", "pata nahi",
         "bata denge", "bata dunga", "ho jayega", "chal raha hai", "thoda bahut")
CONSENT_ASK = ("permission", "consent", "comfortable", "okay with", "ok with", "fine with", "alright with")
YES_WORDS = ("yes", "yeah", "sure", "okay", "ok", "fine", "go ahead", "no problem", "of course",
             "haan", "haanji", "ji", "theek", "thik", "bilkul", "zaroor", "please do", "absolutely")

# Words so common that one alone does not show a checklist topic ("people", "running").
# A line needs one strong topic word, or two different weak ones. Extra words can be set
# in rules.yaml under weak_topics.
WEAK_TOPICS = {"people", "running", "price", "prices", "pay", "paying", "cost", "costs", "bank", "banks",
               "program", "programme", "growth", "customer", "customers", "orders", "sales", "demand",
               "machine", "machines", "staff", "installed"}


def _has_word(text, word):
    return re.search(r"\b" + re.escape(word) + r"\b", text) is not None


def _is_question(text):
    t = text.strip().lower()
    if t.endswith("?"):
        return True
    first = re.split(r"[^a-z']+", t, maxsplit=1)[0] if t else ""
    return first in QUESTION_START


def _has_number(text):
    t = text.lower()
    return bool(re.search(r"\d", t)) or any(_has_word(t, w) for w in NUMBER_WORDS)


STOP_WORDS = {"what", "which", "when", "where", "much", "many", "this", "that", "from", "with", "your", "have",
              "there", "their", "being", "about", "does", "were", "they", "than", "into", "year", "days",
              "will", "would", "could", "should", "been", "also", "some", "only", "very", "just", "and", "the",
              "are", "how", "any", "you", "for", "now", "today", "please", "tell"}


def _stem(w):
    for end in ("ing", "ed", "es", "s"):
        if w.endswith(end) and len(w) - len(end) >= 4:
            return w[: -len(end)]
    return w


def key_words(text):
    """The words that carry the meaning of a question (no small words, no numbers), lightly stemmed."""
    return {_stem(w) for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 3 and w not in STOP_WORDS}


def question_part(text):
    """Only the question sentence(s) of a planned item, not the numbers that come before them.
    "Inventories changed +48.8% ... Is stock being built for confirmed orders? Which customers?"
    -> "Is stock being built for confirmed orders? Which customers?" """
    parts = re.findall(r"[^.?!]*\?", text)
    return " ".join(parts) if parts else text


def question_match_min():
    try:
        import settings
        v = float(settings.get("QUESTION_MATCH_MIN", "0.6"))
        return min(1.0, max(0.3, v))
    except ValueError:
        return 0.6


def _weak_topics():
    try:
        import checklist as checklist_mod
        extra = checklist_mod.load_rules().get("weak_topics") or []
    except Exception:
        extra = []
    return WEAK_TOPICS | {w.lower() for w in extra}


def topics_of(text, keywords, weak):
    """Checklist items a line is about. One strong word, or two different weak words."""
    low = text.lower()
    out = []
    for iid, kws in keywords.items():
        hits = {k for k in kws if _has_word(low, k)}
        strong = [k for k in hits if k not in weak]
        if strong or len(hits) >= 2:
            out.append(iid)
    return out


_WORD = re.compile(r"[a-z0-9']+")


def _words(text):
    return _WORD.findall(text.lower())


def _drop_repeat(prev_text, next_text, max_words=5):
    """Removes words at the start of next_text that repeat the end of prev_text (heard twice in the overlap)."""
    a, b = _words(prev_text), next_text.split()
    for n in range(min(max_words, len(a), len(b)), 0, -1):
        if [w.lower().strip(".,?!;:") for w in b[:n]] == a[-n:]:
            return " ".join(b[n:])
    return next_text


def merge_broken(segs, piece_bounds, edge=0.8):
    """
    segs: sentences on the visit timeline, sorted by start. piece_bounds: {index: (start, end)}.
    1. A sentence from piece N+1 that lies entirely inside the overlap with piece N was
       already heard in piece N: it is dropped.
    2. A sentence that ends at the end of its piece without . ? ! and the sentence that
       starts the next piece are joined into one.
    """
    kept = []
    for s in segs:
        prev_bounds = piece_bounds.get(s["piece"] - 1)
        if prev_bounds and s["end"] <= prev_bounds[1] + 0.05 and s["start"] >= piece_bounds[s["piece"]][0] - 0.05:
            if any(o["piece"] == s["piece"] - 1 and o["end"] >= s["start"] - 0.2 for o in kept):
                continue  # heard twice in the overlap
        kept.append(s)

    out = []
    for s in kept:
        prev = out[-1] if out else None
        if prev is not None and s["piece"] == prev["end_piece"] + 1 and prev["end_piece"] in piece_bounds:
            p_end = piece_bounds[prev["end_piece"]][1]
            n_start = piece_bounds[s["piece"]][0]
            cut_at_end = p_end - prev["end"] < edge
            starts_at_cut = s["start"] - n_start < edge
            unfinished = not prev["text"].rstrip().endswith((".", "?", "!"))
            if cut_at_end and starts_at_cut and unfinished:
                rest = _drop_repeat(prev["text"], s["text"])
                if rest:
                    prev["text"] = prev["text"].rstrip() + " " + rest
                prev["end"] = max(prev["end"], s["end"])
                prev["logprob"] = min(prev.get("logprob", 0.0), s.get("logprob", 0.0))
                prev["loud"] = max(prev["loud"], s["loud"])
                prev["emb"] = voice.mean_vector([e for e in (prev["emb"], s["emb"]) if e is not None])
                prev["lip_key"] = prev["lip_key"] or s["lip_key"]
                prev["visible"] = prev["visible"] + s["visible"]
                prev["end_piece"] = s["piece"]
                prev["merged"] = True
                continue
        out.append(s)
    return out


def place_summary(session, checklist, notes, lines, company):
    """
    Time spent in each place on the 'places to see' list. The analyst's "Now in" taps are the
    main signal; where no tap covers a moment, the picture check's area fills the gap.
    Privacy pauses are not counted anywhere. Places with no time at all are "not shown", and
    company lines that mention such a place are kept as the reason given.
    """
    wanted = [p["name"] for p in (checklist.get("places") or [])]
    bounds = sorted((c["start_ms"] / 1000.0, c["end_ms"] / 1000.0, int(k)) for k, c in session["chunks"].items())
    if not bounds:
        return {"places": [], "untracked_seconds": 0, "paused_seconds": 0}
    end = bounds[-1][1]
    pauses = [(pz["start"], pz["end"] if pz.get("end") is not None else pz["start"]) for pz in session.get("pauses", [])]

    def paused_overlap(a, b):
        return sum(max(0.0, min(b, pe) - max(a, ps)) for ps, pe in pauses)

    taps = sorted(session.get("places", []), key=lambda x: x["t"])
    stretches = []  # (start, end, place, source)
    for i, tp in enumerate(taps):
        t1 = taps[i + 1]["t"] if i + 1 < len(taps) else end
        stretches.append((tp["t"], t1, tp["place"], "tap"))
    first_tap = taps[0]["t"] if taps else end
    lower = {w.lower(): w for w in wanted}
    ai = [n for n in sorted(notes, key=lambda n: n["time"]) if n["time"] < first_tap and n.get("area", "").lower() in lower]
    for i, n in enumerate(ai):
        t1 = min(ai[i + 1]["time"] if i + 1 < len(ai) else first_tap, n["time"] + 30, first_tap)
        stretches.append((n["time"], t1, lower[n["area"].lower()], "picture"))

    totals = {}
    for a, b, place, src in stretches:
        secs = max(0.0, b - a - paused_overlap(a, b))
        t = totals.setdefault(place, {"seconds": 0.0, "first": a, "sources": set()})
        t["seconds"] += secs
        t["first"] = min(t["first"], a)
        t["sources"].add(src)

    out = []
    for name in wanted + [p for p in totals if p not in wanted]:
        t = totals.get(name)
        row = {"name": name, "seconds": round(t["seconds"]) if t else 0, "listed": name in wanted}
        if t:
            row["first"] = round(t["first"], 1)
            row["piece"] = _piece_for(session, t["first"] + 0.5)
            row["by"] = "your taps" if t["sources"] == {"tap"} else "pictures" if t["sources"] == {"picture"} else "taps and pictures"
        else:
            words = [w for w in re.split(r"[^a-z0-9]+", name.lower()) if len(w) > 3]
            row["reasons"] = [{"line": l["id"], "time": l["time"], "text": l["text"], "piece": l["piece"]}
                              for l in lines if company(l) and words and any(_has_word(l["text"].lower(), w) for w in words)][:2]
        out.append(row)
    tracked = sum(r["seconds"] for r in out)
    paused = sum(pe - ps for ps, pe in pauses)
    return {"places": out, "untracked_seconds": max(0, round(end - tracked - paused)), "paused_seconds": round(paused)}


def _piece_for(session, t):
    for key, c in session["chunks"].items():
        if c["start_ms"] / 1000.0 <= t < c["end_ms"] / 1000.0 + 0.5:
            return int(key)
    return None


class _Union:
    def __init__(self):
        self.parent = {}

    def find(self, a):
        self.parent.setdefault(a, a)
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def join(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


# ------------------------------------------------------------------

def finalize(visit_id):
    session = cs.load_session(visit_id)
    pending = [c for c in session["chunks"].values() if c["status"] in ("queued", "processing")]
    if pending:
        # Pieces still being processed: try again shortly, without blocking the worker.
        tries = session.get("finalize_tries", 0)
        if tries < 300:
            cs.update_session(visit_id, lambda s: s.update(finalize_tries=tries + 1))
            pipeline.enqueue_finalize(visit_id, delay=2)
            return
    cs.update_session(visit_id, lambda s: s.update(state="processing"))

    # ---- 0. speech to text again where it failed during the visit ----
    for key, c in sorted(session["chunks"].items(), key=lambda kv: int(kv[0])):
        if c.get("speech_failed"):
            pipeline.retry_speech(visit_id, int(key))
    session = cs.load_session(visit_id)

    visit = storage.load_visit(visit_id)
    checklist = storage.read_json(storage.visit_path(visit_id, "checklist.json"))
    items = {it["id"]: it for it in checklist["items"]}
    notes = cs.read(visit_id, "scene_notes.json", [])

    # ---- 1. collect every sentence ----
    pieces = []
    for key in sorted(session["chunks"], key=int):
        data = cs.read_secret_json(visit_id, "analysis/piece_" + key.zfill(4) + ".json")
        if data:
            pieces.append(data)
    piece_bounds = {int(k): (c["start_ms"] / 1000.0, c["end_ms"] / 1000.0) for k, c in session["chunks"].items()}
    segs = []
    for p in pieces:
        for s in p["segments"]:
            lip = s.get("lip") or {}
            segs.append({
                "start": round(p["start"] + s["start"], 2),
                "end": round(p["start"] + s["end"], 2),
                "text": s["text"],
                "logprob": s.get("logprob", 0.0),
                "loud": s.get("loudness_db", -120.0),
                "emb": s.get("embedding"),
                "lip_key": (p["index"], lip["track"]) if lip.get("track") else None,
                "visible": [(p["index"], t) for t in lip.get("visible", [])],
                "piece": p["index"],
                "end_piece": p["index"],
            })
    segs.sort(key=lambda s: s["start"])
    segs = merge_broken(segs, piece_bounds)

    # ---- 2. what the analyst sounds like, in this room ----
    analyst_print = voice.load_print(session["analyst_email"]) or {}
    ref_emb = analyst_print.get("embedding")
    consent_segs = [s for s in segs if s["start"] < 180 and _has_word(s["text"].lower(), "record")
                    and any(k in s["text"].lower() for k in CONSENT_ASK)]
    ref_loud = None
    how_ref = "voice sample"
    if consent_segs:
        # The analyst reads the consent line: the best sample of their voice in this room.
        ref_loud = median([s["loud"] for s in consent_segs])
        if ref_emb is None:
            ref_emb = voice.mean_vector([s["emb"] for s in consent_segs])
            how_ref = "consent reading"
    elif analyst_print.get("loudness_db") is not None:
        ref_loud = analyst_print["loudness_db"]
    elif segs:
        long = sorted(s["loud"] for s in segs if s["end"] - s["start"] >= MIN_SECONDS)
        if long:
            ref_loud = long[int(len(long) * 0.85)] if len(long) > 3 else long[-1]
            how_ref = "loudest voice (no sample)"

    def analyst_check(s):
        sim = voice.similarity(s["emb"], ref_emb)
        loud = ref_loud is not None and s["loud"] >= ref_loud - LOUD_MARGIN_DB
        return sim, loud

    # ---- 3. people seen speaking, linked over time by position and by voice ----
    uf = _Union()
    for p in pieces:
        for t in p["tracks"]:
            uf.find((p["index"], t["id"]))
    by_index = {p["index"]: p for p in pieces}
    for p in pieces:
        nxt = by_index.get(p["index"] + 1)
        if not nxt:
            continue
        for a in p["tracks"]:
            if a["last_frame"] < p["frames"] - 2:
                continue
            for b in nxt["tracks"]:
                if b["first_frame"] <= 1 and _iou(a["last"], b["first"]) >= 0.3:
                    uf.join((p["index"], a["id"]), (nxt["index"], b["id"]))

    seen_segs = []
    for s in segs:
        if s["end"] - s["start"] < MIN_SECONDS or not s["lip_key"]:
            continue
        sim, loud = analyst_check(s)
        if loud and (sim is None or sim >= SIM_ANALYST_STRONG):
            continue  # the analyst talking while someone on camera smiles or chews
        seen_segs.append(s)

    group_embs = {}
    for s in seen_segs:
        group_embs.setdefault(uf.find(s["lip_key"]), []).append(s["emb"])
    groups = list(group_embs)
    for i, ga in enumerate(groups):
        for gb in groups[i + 1:]:
            sim = voice.similarity(voice.mean_vector(group_embs[ga]), voice.mean_vector(group_embs[gb]))
            if sim is not None and sim >= SIM_PERSON:
                uf.join(ga, gb)

    person_of_root, persons = {}, []
    for s in seen_segs:
        root = uf.find(s["lip_key"])
        if root not in person_of_root:
            pid = "P" + str(len(persons) + 1)
            person_of_root[root] = pid
            persons.append({"id": pid, "label": "Person " + str(len(persons) + 1), "name": "", "embs": []})
        s["person"] = person_of_root[root]
        persons[int(s["person"][1:]) - 1]["embs"].append(s["emb"])
    for p in persons:
        p["centroid"] = voice.mean_vector(p["embs"])

    # ---- 4. label every sentence ----
    # Order: the analyst's voice -> lips on camera -> voice of someone already known ->
    # a new voice not seen on camera ("Voice B"). When lips and voice disagree, the line
    # stays "unknown": a wrong name is worse than no name.
    voice_only = []  # people heard but never seen speaking

    def best_person(emb, pool, floor):
        best, best_sim = None, floor
        for p in pool:
            ps = voice.similarity(emb, p["centroid"])
            if ps is not None and ps >= best_sim:
                best, best_sim = p, ps
        return best

    lines = []
    for n, s in enumerate(segs, start=1):
        dur = s["end"] - s["start"]
        sim, loud = analyst_check(s)
        speaker, how, sure, candidates = None, "", "unsure", []
        if dur < MIN_SECONDS:
            how = "too short to tell"
        elif sim is not None and sim >= SIM_ANALYST and not s.get("person"):
            speaker, how, sure = "analyst", "voice matches the analyst" + (", loud at the mic" if loud else ""), \
                "high" if loud else "medium"
        elif loud and sim is not None and sim >= SIM_ANALYST_STRONG and not s.get("person"):
            speaker, how, sure = "analyst", "loud at the mic and voice is close to the analyst", "medium"
        elif loud and sim is None and not s.get("person"):
            speaker, how, sure = "analyst", "loud at the mic (no voice matching installed)", "medium"
        elif s.get("person"):
            own = persons[int(s["person"][1:]) - 1]
            other = best_person(s["emb"], [p for p in persons if p is not own], SIM_PERSON + 0.07)
            own_sim = voice.similarity(s["emb"], own.get("centroid"))
            if sim is not None and sim >= SIM_ANALYST:
                speaker, how, sure = "unknown", "lips and voice disagree (voice sounds like the analyst)", "low"
            elif other is not None and own_sim is not None and own_sim < 0.55:
                speaker, how, sure = "unknown", "lips and voice disagree", "low"
            else:
                both = own_sim is not None and own_sim >= SIM_PERSON
                speaker, how, sure = s["person"], "seen speaking" + (" and voice matches" if both else ""), "high"
        elif s["emb"] is not None:
            p = best_person(s["emb"], persons, SIM_PERSON) or best_person(s["emb"], voice_only, SIM_PERSON)
            if p is None:
                letter = chr(ord("B") + len(voice_only)) if len(voice_only) < 24 else str(len(voice_only) + 2)
                p = {"id": "V" + str(len(voice_only) + 1), "label": "Voice " + letter, "name": "",
                     "embs": [], "centroid": s["emb"], "kind": "voice"}
                voice_only.append(p)
                how = "new voice, not seen on camera"
            else:
                how = "voice matches" + (" (not seen on camera)" if p in voice_only else "")
            if p in voice_only:
                p["embs"].append(s["emb"])
                p["centroid"] = voice.mean_vector(p["embs"])
            speaker, sure = p["id"], "medium"
        else:
            speaker, how, sure = "unknown", "not seen, and voice matching is not installed", "low"
            near = []
            for other in segs:
                if other.get("person") and abs(other["start"] - s["start"]) <= 120:
                    if other["person"] not in near:
                        near.append(other["person"])
            candidates = near
        lines.append({
            "id": "L" + str(n).zfill(4),
            "time": s["start"], "end": s["end"], "text": s["text"],
            "speaker": speaker, "how": how, "sure": sure, "candidates": candidates,
            "piece": s["piece"], "end_piece": s["end_piece"], "merged": bool(s.get("merged")),
            # the speech model was unsure of these words: the review asks the analyst to check them
            "unclear": s.get("logprob", 0.0) < UNCLEAR_LOGPROB,
        })

    everyone = persons + voice_only

    # ---- 4b. names from "Asking now" taps: the first other voice after the tap ----
    for tap in sorted(session.get("asking", []), key=lambda a: a["t"]):
        for l in lines:
            if l["time"] < tap["t"] - 0.5 or l["time"] > tap["t"] + 90:
                continue
            if l["speaker"] in (None, "analyst", "unknown"):
                continue
            who = next((p for p in everyone if p["id"] == l["speaker"]), None)
            if who is not None and not who.get("name"):
                who["name"] = tap["name"]
                who["named_by"] = "asking_now"
            l["asked"] = tap["name"]
            break

    # ---- 5. topics, area and questions ----
    keywords = {iid: [k.lower() for k in (it.get("topics") or [])] for iid, it in items.items()}
    weak = _weak_topics()
    for line in lines:
        line["topics"] = topics_of(line["text"], keywords, weak)
        line["question"] = line["speaker"] == "analyst" and _is_question(line["text"])
        near = [nt for nt in notes if abs(nt["time"] - line["time"]) <= 10 and nt["area"] != "Unclear"]
        line["area"] = near[0]["area"] if near else None

    company = lambda l: l["speaker"] not in (None, "analyst")  # noqa: E731

    # ---- 6. consent ----
    consent = {"status": "not_found"}
    asks = [l for l in lines if l["time"] < 180 and _has_word(l["text"].lower(), "record")
            and any(k in l["text"].lower() for k in CONSENT_ASK) and l["speaker"] in ("analyst", None)]
    if asks:
        ask = asks[0]
        consent = {"status": "asked_no_reply", "asked_at": ask["time"], "ask_line": ask["id"]}
        for l in lines:
            if ask["time"] < l["time"] <= ask["end"] + 30 and l["speaker"] != "analyst":
                if any(_has_word(l["text"].lower(), w) for w in YES_WORDS):
                    consent.update(status="found", answered_at=l["time"], answer_line=l["id"])
                    break

    # ---- 7. claims (company side, about checklist topics; small talk is ignored) ----
    claims = [{
        "id": "C" + str(i + 1).zfill(3), "line": l["id"], "time": l["time"], "text": l["text"],
        "speaker": l["speaker"], "sure": l["sure"], "items": l["topics"], "piece": l["piece"],
        "end_piece": l["end_piece"], "unclear": l["unclear"],
    } for i, l in enumerate([l for l in lines if company(l) and l["topics"] and l["sure"] != "unsure"])]

    # ---- 8. cues (neutral wording; never "lying" or "nervous") ----
    cues = []
    questions = [l for l in lines if l["question"]]
    gaps = []
    for qi, q in enumerate(questions):
        next_q = questions[qi + 1]["time"] if qi + 1 < len(questions) else float("inf")
        replies = [l for l in lines if company(l) and q["end"] <= l["time"] < min(next_q, q["end"] + 45)]
        if q["sure"] == "high" and replies and replies[0]["sure"] in ("high", "medium"):
            between = [l for l in lines if q["end"] <= l["time"] < replies[0]["time"]]
            if not between:
                gaps.append((q, replies[0], replies[0]["time"] - q["end"]))
        q_low = q["text"].lower()
        if q["topics"] and any(k in q_low for k in NUMBER_ASK) and replies:
            if not any(_has_number(r["text"]) for r in replies):
                cues.append({"type": "no_number", "time": q["time"], "line": q["id"],
                             "reply_lines": [r["id"] for r in replies], "items": q["topics"],
                             "piece": q["piece"],
                             "text": "Asked for a number. The reply did not include one."})
    # Each person is compared with their OWN usual gap before answering (at least 3 answers).
    # With fewer, the usual gap in this meeting is used; with fewer than 3 in all, a fixed 5 s.
    meeting_usual = median([g for _, _, g in gaps]) if len(gaps) >= 3 else None
    own = {}
    for _, r, g in gaps:
        own.setdefault(r["speaker"], []).append(g)
    for q, r, gap in gaps:
        mine = own.get(r["speaker"], [])
        if len(mine) >= 3:
            usual, basis = median(mine), "this person's usual"
        else:
            usual, basis = meeting_usual, "usual in this meeting"
        long_pause = gap >= 3 and (gap >= 2.5 * usual if usual else gap >= 5)
        if long_pause and (q["topics"] or r["topics"]):
            text = "Answer began " + format(gap, ".1f") + " s after the question"
            text += " (" + basis + ": " + format(usual, ".1f") + " s)." if usual else "."
            cues.append({"type": "long_pause", "time": r["time"], "line": r["id"], "question_line": q["id"],
                         "items": sorted(set(q["topics"] + r["topics"])), "piece": r["piece"], "text": text})
    for l in lines:
        if company(l) and l["topics"]:
            found = [v for v in VAGUE if v in l["text"].lower()]
            if found:
                cues.append({"type": "vague", "time": l["time"], "line": l["id"], "items": l["topics"],
                             "piece": l["piece"], "text": "Hedging words used: " + ", ".join(found) + "."})
    cues.sort(key=lambda c: c["time"])
    for i, c in enumerate(cues):
        c["id"] = "Q" + str(i + 1).zfill(3)

    # ---- 9. suggestions (the analyst accepts or dismisses each one) ----
    suggestions = []
    for iid, it in items.items():
        if it["kind"] != "look_for":
            continue
        votes = [(nt, nt["answers"][iid]) for nt in notes
                 if iid in nt["answers"] and nt["answers"][iid]["means"] in ("ok", "issue")]
        if not votes:
            continue
        issue = [v for v in votes if v[1]["means"] == "issue"]
        ok = [v for v in votes if v[1]["means"] == "ok"]
        side = issue if len(issue) >= len(ok) else ok
        option = side[0][1]["option"]
        suggestions.append({
            "item": iid, "status": "issue" if side is issue else "ok", "source": "pictures",
            "text": "Pictures: \"" + option + "\" in " + str(len(side)) + " of " + str(len(votes)) + " checks.",
            "evidence": [{"time": nt["time"], "piece": nt["piece"]} for nt, _ in side][:6],
        })
    # A question counts as one PLANNED question only if it contains most of that question's
    # key words (QUESTION_MATCH_MIN, default 60%), and then only the best match counts.
    # A passing mention of "stock" is not "asked".
    need = question_match_min()
    for q in questions:
        qw = key_words(q["text"])
        best, best_share = None, 0.0
        for iid, it in items.items():
            if it["kind"] != "ask":
                continue
            iw = key_words(question_part(it["text"]))
            if not iw:
                continue
            share = len(qw & iw) / float(len(iw))
            if share > best_share:
                best, best_share = iid, share
        if best and best_share >= need:
            q["ask_item"] = best
            total = len(key_words(question_part(items[best]["text"])))
            q["match"] = {"shared": round(best_share * total), "of": total}
    for iid, it in items.items():
        if it["kind"] != "ask":
            continue
        asked = [q for q in questions if q.get("ask_item") == iid]
        if not asked:
            continue
        q = asked[0]
        replies = [l for l in lines if company(l) and q["end"] <= l["time"] < q["end"] + 45]
        if not replies:
            continue
        reply_ids = {r["id"] for r in replies}
        item_cues = [c for c in cues if c["line"] == q["id"] or c.get("question_line") == q["id"]
                     or c["line"] in reply_ids]
        matched = " (" + str(q["match"]["shared"]) + " of " + str(q["match"]["of"]) + " key words)"
        if item_cues:
            text = "Asked at " + cs.fmt_time(q["time"]) + matched + ". " + item_cues[0]["text"]
            status = "issue"
        else:
            text = "Asked at " + cs.fmt_time(q["time"]) + matched + " and answered at " + cs.fmt_time(replies[0]["time"]) + "."
            status = "ok"
        evidence = []
        for e in [{"time": q["time"], "piece": q["piece"]}] + [{"time": c["time"], "piece": c["piece"]} for c in item_cues[:2]]:
            if e not in evidence:
                evidence.append(e)
        suggestions.append({
            "item": iid, "status": status, "source": "conversation", "text": text, "evidence": evidence,
        })
    for i, sg in enumerate(sorted(suggestions, key=lambda x: x["item"])):
        sg["id"] = "S" + str(i + 1).zfill(3)
        sg["decision"] = None
    suggestions.sort(key=lambda x: x["id"])

    discussed = {iid for l in lines for iid in l["topics"]}
    not_discussed = [iid for iid, it in items.items()
                     if it["kind"] == "ask" and it.get("topics") and iid not in discussed]

    # ---- 9b. places: time spent in each, and the ones never shown ----
    places = place_summary(session, checklist, notes, lines, company)

    # ---- 10. keep only clips that back up something ----
    line_by_id = {l["id"]: l for l in lines}

    def keep_line(line_id):
        # A sentence cut across two pieces keeps BOTH clips, so the whole sentence can be played.
        l = line_by_id.get(line_id)
        if l:
            keep.update(range(l["piece"], l["end_piece"] + 1))

    keep = set()
    for m in session.get("marks", []):
        p = _piece_for(session, m["t"])
        if p is not None:
            keep.add(p)
    for c in claims:
        keep_line(c["line"])
    for c in cues:
        keep.add(c["piece"])
        keep_line(c["line"])
    for sg in suggestions:
        keep.update(e["piece"] for e in sg["evidence"])
    for key in ("ask_line", "answer_line"):
        if consent.get(key):
            keep_line(consent[key])
    for pl in places["places"]:
        if pl.get("piece") is not None:
            keep.add(pl["piece"])
        for r in pl.get("reasons", []):
            keep_line(r["line"])

    # Never throw away what was never analysed: pieces with no transcript (speech failed twice)
    # or no working data keep their blurred clip, and the review asks the analyst to listen.
    analysed = {p["index"] for p in pieces}
    not_analysed, lost = [], []
    for key, c in session["chunks"].items():
        i = int(key)
        has_clip = cs.path(visit_id, "pending/" + pipeline._clip_name(i)).exists()
        if c.get("speech_failed") or i not in analysed or c["status"] == "failed":
            if has_clip:
                not_analysed.append(i)
                keep.add(i)
            else:
                lost.append(i)  # nothing was saved; the unblurred piece was still deleted for privacy

    kept_bytes = 0
    for key, c in session["chunks"].items():
        name = pipeline._clip_name(int(key))
        src = cs.path(visit_id, "pending/" + name)
        if not src.exists():
            continue
        if int(key) in keep:
            dst = cs.path(visit_id, "clips/" + name)
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.replace(dst)
            kept_bytes += dst.stat().st_size
        else:
            cs.delete_file(visit_id, src, "blurred clip not linked to any evidence")

    # Working data holds voice prints of company people: delete it now.
    adir = cs.path(visit_id, "analysis")
    if adir.exists():
        for f in adir.iterdir():
            cs.delete_file(visit_id, f, "working data with voice prints")

    people = []
    for p in everyone:
        mine = [l for l in lines if l["speaker"] == p["id"]]
        if not mine:
            continue
        quotes = sorted(mine, key=lambda l: len(l["text"]), reverse=True)[:3]
        people.append({
            "id": p["id"], "label": p["label"], "name": p.get("name", ""),
            "named_by": p.get("named_by"), "kind": p.get("kind", "seen"),
            "lines": len(mine), "seen": sum(1 for l in mine if l["how"] == "seen speaking"),
            "quotes": [{"time": q["time"], "text": q["text"], "piece": q["piece"]} for q in quotes],
        })

    cs.write(visit_id, "transcript.json", {"analyst_reference": how_ref, "lines": lines})
    cs.write(visit_id, "people.json", {"people": people})
    cs.write(visit_id, "claims.json", claims)
    cs.write(visit_id, "cues.json", cues)
    cs.write(visit_id, "suggestions.json", suggestions)

    def done(s):
        s["state"] = "done"
        s["finalized_at"] = storage.now_iso()
        s["consent"] = consent
        s["not_discussed"] = not_discussed
        s["kept_pieces"] = sorted(keep)
        s["not_analysed"] = sorted(not_analysed)
        s["lost_pieces"] = sorted(lost)
        s["places_summary"] = places
        s["meters"]["kept_bytes"] = kept_bytes
        s["meters"]["pending_bytes"] = 0
        s.pop("last_picture_thumb", None)
    cs.update_session(visit_id, done)
    storage.append_audit(visit_id, session["analyst_email"], "visit_processed", {
        "lines": len(lines), "claims": len(claims), "cues": len(cues), "kept_clips": len(keep),
        "not_analysed": len(not_analysed),
    })
    storage.refresh_index(visit)
