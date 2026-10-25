# SiteSense

A copilot for analysts' company visits. Team Buffer, Thapar x Japan Hackathon.

> The goal is not more data. It is better judgment.

| Phase | What happens | Who | Where |
|---|---|---|---|
| **1. Before** | Manager creates and assigns the visit. Analyst uploads financials, confirms numbers, gets a checklist and a list of places to see. Manager approves, analyst locks | Manager + analyst | Laptop |
| **2. During** | The phone records 10-second pieces. The laptop blurs faces, turns speech into text, works out who said what, and deletes the unblurred video within seconds | Analyst | Phone + laptop |
| **2. Right after** | Review: consent, who spoke, suggested ticks, places, transcript. Locked with a fingerprint | Analyst | Laptop |
| **3. After** | Findings: said vs numbers vs seen, per warning sign. Analyst keeps or removes each one. Report, manager approval, lock, PDF | Analyst + manager | Laptop |

```
sitesense/
  backend/    FastAPI (Python): login, roles, encrypted storage, numbers, rules,
              video and speech processing, matching and the report
  frontend/   React + Vite + Tailwind: every screen, including the phone pages
```

Every visit page shows one **Next step** bar at the top: what to do now, and a button to do it.

---

## 1. Install (once)

You need **Python 3.10+**, **Node 18+** and **ffmpeg** (`ffmpeg -version` to check).
- Windows: `winget install ffmpeg` · Mac: `brew install ffmpeg` · Linux: `sudo apt install ffmpeg`

**Backend**
```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate     Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
python setup_env.py        # creates .env with fresh secrets
python seed_demo.py        # demo accounts + one sample visit
python prepare_speech.py   # downloads the speech model once (about 145 MB). Needed: Start visit stays blocked without it
```

Optional: `pip install -r requirements-voice.txt` adds voice matching (PyTorch, a few hundred MB). It is what tells voices apart ("Voice B") and lets "Asking now" put names on people who are not on camera. Without it, the analyst is found by loudness and people only by lips on camera.

**Frontend**
```bash
cd frontend
npm install
```

## 2. Run

```bash
# terminal 1
cd backend && uvicorn main:app --reload --port 8000
# terminal 2
cd frontend && npm run demo
```

`npm run demo` builds the app once and serves it as one small bundle: the most reliable way for phones. (`npm run dev` also works, for editing code.)

Open **https://localhost:5173** on the laptop and accept the certificate warning once (phones only allow the camera on https pages).

**The phone never signs in.** On the Visit step, the laptop shows a QR code. Scanning it connects that phone to that one visit: it can only record it (no other pages, no other visits). The code works once and changes every few minutes.

| Demo account | Role | Password |
|---|---|---|
| rohan.verma@valuecreate.test | Manager | SiteSense@2026 |
| aarav.mehta@valuecreate.test | Analyst | SiteSense@2026 |
| neha.kapoor@valuecreate.test | Analyst | SiteSense@2026 |

---

## 3. Demo script (about 10 minutes)

Use two browser windows: one signed in as the manager (Rohan), one as the analyst (Aarav).

Screens update by themselves: no need to reload when the other person acts. The manager sees only their part (create, assign, approve, send back) and a "Waiting for you" list on the home page.

**Phase 1 (laptop)**
1. Manager: **New visit**. Sakura Precision Parts Limited, Plant, Pune, today. Add a person: *Mr. Rao, CFO*. Assign to Aarav.
2. Analyst: **Accept**. Upload **only the two Sakura files** from `backend/demo_data/`. **Read numbers**; for Trade receivables pick a value with **Use this**; **Confirm numbers**.
3. **Build checklist**: 8 warning signs. Under **Places to see**, add *R&D lab*, **Save places**. **Submit for approval**.
4. Manager: **Approve** (optional comment) or **Send back** (with a note the analyst sees at the top). Analyst: **Lock for visit**.

**Phase 2 (phone + laptop)**
1. Phone and laptop on the same wifi (a phone hotspot works best). On the laptop, open the **Visit** step and scan the QR code with the phone's camera, then open the link in **Chrome or Safari**. No sign-in.
2. **Start visit**, read the consent line aloud. A teammate plays the CFO and says yes. (The checklist and ticks are on the phone only after Start.)
3. Tap **Now in → Production floor**. Tap **Asking now → Mr. Rao, CFO**, then ask the planned question in your own words: *"How many shifts run today, and which lines are at full capacity?"* The CFO, after a pause: *"We are running at roughly ninety percent capacity."* (A spoken question counts as a planned one only if it has most of its key words; see `QUESTION_MATCH_MIN`.)
4. Open the phone **List**, tick *"Count machines running and idle"* as **Issue found**: *Line 3 covered*.
5. Tap **End visit**. The phone warns *"Not shown yet: Warehouse, R&D lab"* and lists questions not asked. End.
6. Laptop: **Review**. Consent found, *Mr. Rao, CFO* named from Asking now, places with times, interview transcript. **Finish and lock review**.

**Phase 3 (laptop)**
1. Analyst: **Findings → Build findings**. The capacity card says **Doesn't match**: said 90% (matches the report's 92%), but your tick says idle machines. Press ▶ to play the clip.
2. The inventory card says **Not shown**: the warehouse was never shown.
3. **Keep** the real ones, **Remove** one with a reason. Go to the **Report**, write a 2-line summary, **Send to manager**.
4. Manager: **Send back** with a note once, then the analyst sends again, then **Approve and lock**. **Download PDF**. **Check nothing changed**.

**No wifi on stage?** On the Visit step, choose **Process a video you already recorded**: it goes through exactly the same steps (without the phone taps).

---

## 4. How it works

### Phase 2: one 10-second piece
```
PHONE                            LAPTOP                                          KEPT
records 10 s pieces,  --wifi-->  1. saved ENCRYPTED
next one starts 0.5 s early      2. speech to text, on the laptop               -> sentences
(no word lost at the cut)        3. faces followed frame to frame,
                                    mouth movement vs sound                     -> who is speaking on camera
                                 4. every face BLURRED once
                                 5. 1 blurred picture per 5 s, checked again
                                    for faces, then AI with FIXED answers       -> picture notes
                                 6. blurred clip saved (with sound)             -> pending clip
                                 7. unblurred piece + temp folder DELETED, logged
AFTER "End visit"                8. speech retried for any piece that failed
                                 9. cut sentences joined, speakers, consent,
                                    claims, cues, places, suggestions
                                10. only clips that back up something kept      -> a few MB per visit
                                11. company voice prints deleted
```

### Who said it (each sentence, after joining cut sentences)
| Order | Check | Label |
|---|---|---|
| 0 | Shorter than 1.5 s | unsure |
| 1 | Voice matches the analyst | the analyst |
| 2 | Lips on camera move with the sound | that person, "seen speaking" |
| 2b | Lips say one person, voice says another | **unknown**: a wrong name is worse than none |
| 3 | Voice matches someone already known | that person |
| 4 | A new voice | "Voice B", "Voice C"... |
| + | **Asking now** tap | the first other voice after the tap gets that name |

### Phase 3: matching (`backend/match.py`, no AI)
For every warning sign that fired: **Said** (company statements), **Numbers** (confirmed figure + cell or page), **Seen** (your ticks > accepted suggestions > picture checks; places never shown).

| Verdict | When |
|---|---|
| Doesn't match | a statement differs from the number (±5 pts for %, ±10% otherwise), or what was seen goes against it |
| Not shown | none of the places this sign depends on were shown, and nothing was seen |
| Supported | at least one check agrees and none disagree |
| Couldn't check | nothing to compare |

Numbers are read from speech in English or Hindi ("ninety percent", "two months", "400 lakh", "pachaas pratishat"). Six rules have a `compare:` block in `rules.yaml`.

---

## 5. Privacy and security

| What | How |
|---|---|
| Faces | Blurred before anything is saved or sent. Pictures for the AI are checked for faces again; if one is still found, the picture is not sent |
| Unblurred video | On the laptop for seconds per piece. Deleted even if a step crashes. Temp folders left by a crash are deleted at start-up. Every deletion logged |
| Nothing analysed is thrown away | If speech to text fails, it is retried from the blurred clip; if it still fails, the clip is kept and Review asks you to listen |
| Recording only when ready | Start visit is blocked until ffmpeg, the face finder and speech to text are ready (`REQUIRE_SPEECH`) |
| AI | Only blurred pictures, fixed answers. Speech to text runs on the laptop. No AI in Phase 3 |
| Storage | Documents, clips, transcript, claims, findings, report and the analyst's voice print are encrypted. `python rotate_keys.py` re-encrypts everything |
| Proof | Review and report are locked and fingerprinted (SHA-256). "Check nothing changed" verifies it |
| Legal hold | While on, nothing can delete a visit's kept clips or results. Kept clips are never deleted automatically |
| Roles | Manager creates, assigns and approves (never their own visit). Analyst works only after accepting. Checked on every request |
| Audit | Every action per visit is in the activity log |

---

## 6. Where things are stored
```
backend/data/visits/VIS-0002/
  visit.json, docs/, metrics*.json, checklist.json, audit_log.jsonl   Phase 1
  capture/   session.json, clips/ (kept, encrypted), transcript.json, people.json,
             claims.json, cues.json, suggestions.json, scene_notes.json,
             manifest.json, deletion_log.jsonl                         Phase 2
  report/    findings.json, report.json  (encrypted)                   Phase 3
```

## 7. Settings (`backend/.env`)
| Setting | Default | What it does |
|---|---|---|
| `WHISPER_MODEL` | small | tiny, base (faster), small (more accurate, the default). Use base if pieces take longer than 10 s |
| `WHISPER_LANGUAGE` | en | Language spoken; empty to auto-detect |
| `REQUIRE_SPEECH` | true | Block Start visit until speech to text is ready |
| `QUESTION_MATCH_MIN` | 0.6 | Share of a planned question's key words a spoken question must contain to count as asked (0.75 = stricter) |
| `REQUIRE_APPROVAL` | true | Manager approval for checklist and report |
| `LLM_API_KEY` | empty | Turns on picture checks and AI help for messy documents (a free Gemini key works) |
| `CAPTURE_AI_BUDGET` | 80 | Most picture checks per visit |

## 8. Common problems
| Problem | Fix |
|---|---|
| "This laptop is not ready to record" | Run `python prepare_speech.py` once with internet, then restart the backend |
| Phone shows "Live recording needs a secure page" | Open the https:// link from the QR code and accept the certificate warning |
| Phone cannot open the QR link | Same wifi? Use a phone hotspot; allow Node and Python through the firewall |
| Everyone is "Unknown speaker" | Install voice matching; tap Asking now before each question |
| "A stored file could not be decrypted" | `.env` was regenerated; delete `backend/data/` and run `seed_demo.py` |
| Start over | Stop the backend, delete `backend/data/`, run `python seed_demo.py` |

## 9. Honest limits
- Speakers are best in a quiet room. On a noisy floor, rely on ticks, pictures and Asking now.
- Lip detection needs a visible, roughly front-facing face within about 3 m (YuNet face finder).
- Blurring uses YuNet on edge-padded frames plus a side-face detector, with large boxes carried 5 frames either way. A face that is very small, mostly hidden or in strong backlight can still be missed for a moment: check clips in Review before sharing them.
- Places come from your "Now in" taps; pictures fill gaps only for places named like the checklist areas.
- Only faces are blurred: a whiteboard or screen in a picture can still reach the AI.
- Warning-sign thresholds and comparison tolerances are starting values, not calibrated on real data.
- Logging out does not cancel a copied login cookie (valid up to 8 hours).
- If wifi drops and the phone's tab is closed, pieces still waiting on the phone are lost.
- Phase 1 files (numbers, checklist) are stored as plain JSON.

## Credits
YuNet face model (OpenCV Model Zoo, MIT), OpenCV Haar face detectors (Intel License, in `backend/models/`), faster-whisper (MIT), Resemblyzer (Apache 2.0, optional), Atkinson Hyperlegible font (SIL OFL). Sakura Precision Parts and Kaveri Logistics are **fictional**.
