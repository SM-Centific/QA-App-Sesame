#!/usr/bin/env python3
"""Browser check of the review rules in the real page (headless Chromium).

  * PII visible: starts at No; flipping it to Yes fails the episode
  * Moderator visible and moving: starts blank; Yes/No feed the P1 average
  * Session rule: C0 must pass; a room is kept with >= 10 passing episodes;
    the session passes when C0 passes and at least one room is kept
  * Save will not run until the session has a Pass/Fail decision, and then
    writes a 'session' row with the decision and the recommendation
  * The Scoring guide link opens help.html, which loads cleanly

Sign-in and SharePoint are faked; nothing real is read or written.

    python3 scripts/test_review_rules.py

Requires: numpy, tqdm, playwright (with Chromium installed).
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_app_zones as t  # noqa: E402

CASES = [  # (C0 gate, room gates) -> expected recommendation
    ("C0 fails", False, [True, True], "fail"),
    ("C0 passes, one room kept", True, [True], "pass"),
    ("C0 passes, one room rejected", True, [False], "fail"),
    ("C0 passes, 1 of 3 rooms kept", True, [False, True, False], "pass"),
    ("C0 passes, all 3 rooms rejected", True, [False, False, False], "fail"),
    ("C0 passes, rooms not scored yet", True, [None, None], "incomplete"),
    ("C0 not scored, one room kept", None, [True], "incomplete"),
]


def main():
    work = Path(tempfile.mkdtemp(prefix="review_rules_"))
    fixture = work / "blob"
    subprocess.run([sys.executable, str(t.ROOT / "scripts" / "make_zone_fixture.py"), str(fixture)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    port = t.free_port()
    t.serve(t.ROOT, t.QuietStatic, port)
    writes = []
    failures = []

    def check(name, ok, detail=""):
        tqdm.write(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    def fulfil(route):
        body = route.request.post_data or ""
        if "152a06201a4642339d1e07e930f329d4" in route.request.url:
            r = {"authorized": True, "role": "reviewer"}
        elif "payload_json" in body:
            writes.append(json.loads(json.loads(body)["payload_json"]))
            r = {"ok": True}
        else:
            r = {"value": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(r))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 1000})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/*powerplatform.com*/**", fulfil)
        page.goto(f"http://127.0.0.1:{port}/index.html")
        page.fill("#accessEmail", "tester@centific.com")
        page.click("#accessSubmit")
        page.wait_for_selector("#appRoot", state="visible")
        files = [str(fixture / f"{stem}{ext}") for stem in (t.STEM, t.C0_STEM)
                 for ext in (".mmwave.bin", ".episode_markers.jsonl", ".mmwave_sync.json", ".capture.json")]
        page.set_input_files("#fileInput", files)
        page.wait_for_function("Object.values(formCache).some(f => f.episodeId === 'ep-1')", timeout=60000)

        ep = "(() => formCache[Object.keys(formCache).find(k => k.endsWith('__ep__ep-1'))])()"
        vals = page.evaluate(f"(() => {{ const f = {ep}; return [f.values.pii, f.values.moderator_visible]; }})()")
        check("PII starts at No, moderator starts blank", vals == ["no", None], str(vals))

        # Open the episode form and use the real controls.
        page.locator("#scenarioTabs button[data-scenario='T1-R2']").click()
        page.get_by_text("Participant").first.click()
        page.select_option("select", "ep-1")
        page.wait_for_selector(".flip[data-item='pii']")
        before = page.evaluate(f"computeScores(ITEMS_PARTICIPANT, {ep}.values)")
        page.locator(".flip[data-item='pii']").click()
        page.wait_for_selector(".flip.on[data-item='pii']")
        after = page.evaluate(f"computeScores(ITEMS_PARTICIPANT, {ep}.values)")
        check("PII Yes fails the episode", after["overall"] == "fail" and after["gateFailed"],
              f"before {before['overall']}, after {after['overall']}")
        page.locator(".flip[data-item='pii']").click()
        page.wait_for_selector(".flip:not(.on)[data-item='pii']")

        p1_blank = page.evaluate(f"computeScores(ITEMS_PARTICIPANT, {ep}.values).p1Pct")
        page.locator(".seg[data-item='moderator_visible'][data-value='no']").click()
        p1_no = page.evaluate(f"computeScores(ITEMS_PARTICIPANT, {ep}.values).p1Pct")
        page.locator(".seg[data-item='moderator_visible'][data-value='yes']").click()
        p1_yes = page.evaluate(f"computeScores(ITEMS_PARTICIPANT, {ep}.values).p1Pct")
        check("Moderator No lowers P1, Yes raises it", p1_no < p1_blank < p1_yes,
              f"No {p1_no:.1f} < blank {p1_blank:.1f} < Yes {p1_yes:.1f}")

        # Session rule, with the C0 and room gates stubbed.
        page.evaluate("window.__realC0 = computeC0Gate; window.__realRoom = computeRoomGate; window.__realIds = getIngestedRoomIds;")
        for name, c0, rooms, want in tqdm(CASES, desc="session rule", unit="case"):
            got = page.evaluate("""([c0, rooms]) => {
              computeC0Gate = async () => ({gatePass: c0, p0Pct: null});
              getIngestedRoomIds = () => rooms.map((_, i) => 'T1-R' + (i + 1));
              computeRoomGate = async id => ({gatePass: rooms[Number(id.slice(4)) - 1], blendedP0Pct: null, blendedP1Pct: null});
              return computeSessionSummary().then(s => [s.sessionPass, s.reason]);
            }""", [c0, rooms])
            check(f"Session: {name}", got[0] == want, f"{got[0]} ({got[1]})")
        page.evaluate("computeC0Gate = window.__realC0; computeRoomGate = window.__realRoom; getIngestedRoomIds = window.__realIds;")

        # The fixture room has 3 episodes, so it cannot reach 10: rejected.
        real = page.evaluate("computeSessionSummary().then(s => [s.sessionPass, s.reason, s.rejected])")
        check("Recommendation uses scores on screen before any Save: 3-episode room rejected", "T1-R2" in real[2] and real[0] == "fail", f"{real[0]} ({real[1]})")

        # Save is blocked without a decision.
        page.evaluate("renderSessionBanner()")
        writes.clear()
        page.click("#globalSaveBtn")
        page.wait_for_timeout(800)
        check("Save without a decision writes nothing", not writes, f"{len(writes)} row(s) written")
        check("Save without a decision says why", "choose Pass or Fail" in page.inner_text("#loadLog"))

        page.locator("#sessionDecisionRow [data-decision='fail']").click()
        page.click("#globalSaveBtn")
        page.wait_for_function("document.querySelector('.decision-note') && /Saved/.test(document.querySelector('.decision-note').textContent)", timeout=15000)
        rows = [w for w in writes if w.get("kind") == "session"]
        row = rows[-1] if rows else {}
        check("Save with a decision writes the session row",
              row.get("decision") == "fail" and row.get("recommended") == "fail" and "T1-R2" in row.get("roomsRejected", []),
              json.dumps({k: row.get(k) for k in ("decision", "recommended", "roomsRejected", "decidedBy")}))
        check("Episode rows saved alongside", any(w.get("episodeId") == "ep-1" and w["scores"].get("moderator_visible") == "yes" for w in writes))

        # Guide link.
        href = page.get_attribute("a.btn[href='help.html']", "target")
        guide = browser.new_page()
        guide_errors = []
        guide.on("pageerror", lambda e: guide_errors.append(str(e)))
        guide.goto(f"http://127.0.0.1:{port}/help.html")
        sections = guide.locator("h2").count()
        flags_ok = guide.locator("#flags").count() == 1
        check("Scoring guide opens in a new tab and loads", href == "_blank" and sections >= 9 and flags_ok and not guide_errors,
              f"{sections} sections")
        check("No page errors", not errors, "; ".join(errors))
        browser.close()

    print(f"\n{len(failures)} failure(s)" if failures else "\nall checks passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
