#!/usr/bin/env python3
"""Browser check: radar scores are filled on the forms.

Builds the zone fixture (episode 1 in front = Blue, episode 2 a brief exit
to the side within 3 m, episode 3 lingering to the side beyond 3 m, plus a
C0 capture where the rig rests, is moved, and rests), then drives the real
page in headless Chromium through each input path:

  * public  / files   - static hosting (like GitHub Pages), files dropped by hand
  * public  / report  - static hosting, inspection CSV uploaded
  * server  / files   - review_server.py running, files dropped by hand
  * server  / report  - review_server.py running, inspection CSV uploaded
  * public  / no-cors - static hosting, blob host without CORS: expect a clear
                        message naming CORS instead of silent empty scores
  * <host>  / split   - files dropped by hand in separate batches: C0 metadata
                        then its .bin; the T1 .bin before its metadata. Each
                        drop must add to what is loaded, not wipe it
  * <host>  / daily   - a daily report with two sessions (session taken from the
                        UUID in each blob path): pick the second one; only its
                        files may be downloaded and it must load as its own session

The Power Automate sign-in and score endpoints are faked so no real
SharePoint data is read or written.

    python3 scripts/test_app_zones.py            # all four
    python3 scripts/test_app_zones.py public     # just the static-site paths

Requires: numpy, tqdm, playwright (with Chromium installed).
"""

import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
STEM = "P02_scenarioRunner_c004"
EXPECT = {  # episodeId -> (blue %, outside view beyond 3 m %)
    "ep-1": (100.0, 0.0),
    "ep-2": (0.0, 0.0),     # brief exit within 3 m: allowed, not counted
    "ep-3": (0.0, 100.0),
}
# C0 suggestions from rig motion: at rest at both ends, moved in the middle
# for 4 of the middle 10 s (40%), which suggests a 2 for the motion items.
EXPECT_C0 = {"static_5s": 3, "static_end": 3, "figure_8": 2, "translation": 2}
C0_STEM = "P02_scenarioRunner_c001"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


REQUESTED = []  # paths fetched from the fake blob host


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    """Static files with the CORS headers Azure Blob sends once CORS is enabled."""

    def do_GET(self):
        REQUESTED.append(self.path.split("?")[0])
        return super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start_s, end_s = rng.replace("bytes=", "").split("-")
        start = int(start_s)
        end = min(int(end_s) if end_s else size - 1, size - 1)
        fh = open(path, "rb")
        fh.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_left = end - start + 1
        return fh

    def copyfile(self, source, outputfile):
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(65536, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)

    def log_message(self, *args):
        pass


class QuietStatic(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory, handler, port):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(handler, directory=str(directory)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def fake_backend(page):
    def fulfil(route):
        url = route.request.url
        if "152a06201a4642339d1e07e930f329d4" in url:  # access check
            body = {"authorized": True, "role": "reviewer"}
        elif route.request.method == "POST" and "payload_json" in (route.request.post_data or ""):
            body = {"ok": True}
        else:
            body = {"value": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
    page.route("**/*powerplatform.com*/**", fulfil)
    page.route("**/*powerautomate*/**", fulfil)


def episode_values(page):
    return page.evaluate("""() => {
      const out = {};
      Object.values(formCache).forEach(f => {
        if (f.kind === 'participant') out[f.episodeId] = {
          blue: f.values.blue_zone_pct, orange: f.values.outside_far,
          blueNote: f.autos.blue_zone_pct && f.autos.blue_zone_pct.note };
        if (f.kind === 'c0') out.__c0 = {static_5s: f.values.static_5s, static_end: f.values.static_end,
          figure_8: f.values.figure_8, translation: f.values.translation};
      });
      return out;
    }""")


def run_case(browser, app_url, mode, fixture, report="inspection_report.csv"):
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    fake_backend(page)
    page.goto(app_url)
    page.fill("#accessEmail", "tester@centific.com")
    page.click("#accessSubmit")
    page.wait_for_selector("#appRoot", state="visible")
    meta = (".episode_markers.jsonl", ".mmwave_sync.json", ".capture.json")
    if mode == "files":
        files = [str(fixture / f"{stem}{ext}") for stem in (STEM, C0_STEM) for ext in
                 (".mmwave.bin",) + meta]
        page.set_input_files("#fileInput", files)
        status_sel = "#sessionStatus"
    elif mode == "split":
        def drop(paths):
            page.set_input_files("#fileInput", [str(fixture / x) for x in paths])
            page.wait_for_function("!document.getElementById('dropzone').classList.contains('busy')", timeout=120000)
            page.wait_for_timeout(300)
        drop([C0_STEM + e for e in meta])
        drop([C0_STEM + ".mmwave.bin"])
        drop([STEM + ".mmwave.bin"])          # before its metadata
        drop([STEM + e for e in meta])        # triggers a re-read of that .bin
        status_sel = "#sessionStatus"
    else:
        page.set_input_files("#reportInput", str(fixture / report))
        status_sel = "#reviewStatus"
    deadline = time.time() + 120
    vals = {}
    while time.time() < deadline:
        vals = episode_values(page)
        if all(k in vals and vals[k]["blue"] is not None for k in EXPECT):
            break
        if "CORS" in page.inner_text("#loadLog") + page.inner_text(status_sel):
            break
        time.sleep(0.5)
    if mode == "report":
        status_sel = "#reviewStatus"
    status = page.inner_text(status_sel) + " | log: " + " / ".join(
        line for line in page.inner_text("#loadLog").splitlines() if "CORS" in line or "radar" in line.lower())
    page.close()
    return vals, status, errors


SESSION_A = "11111111-aaaa-4aaa-8aaa-111111111111"
SESSION_B = "22222222-bbbb-4bbb-8bbb-222222222222"


def build_daily_report(fixture, port):
    """Two sessions laid out like blob storage: <uuid>/phases/P02_scenarioRunner/raw/<file>.
    No session_id column, so the app has to take the session from the path."""
    names = [f"{STEM}{ext}" for ext in (".mmwave.bin", ".episode_markers.jsonl", ".mmwave_sync.json", ".capture.json")]
    lines = ["scenario_id,filename,blob_path,sas_token,video_preview_url"]
    for sid in (SESSION_A, SESSION_B):
        raw = fixture / sid / "phases" / "P02_scenarioRunner" / "raw"
        raw.mkdir(parents=True, exist_ok=True)
        for name in names:
            src = fixture / name
            if name.endswith(".capture.json"):
                obj = json.loads(src.read_text())
                obj["sessionId"] = sid
                (raw / name).write_text(json.dumps(obj))
            elif not (raw / name).exists():
                (raw / name).symlink_to(src)
            lines.append(f"T1-R2,{name},http://127.0.0.1:{port}/{sid}/phases/P02_scenarioRunner/raw/{name},sv=test&sig=x,")
    (fixture / "daily_report.csv").write_text("\n".join(lines) + "\n")


def run_daily(browser, app_url, fixture):
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    fake_backend(page)
    page.goto(app_url)
    page.fill("#accessEmail", "tester@centific.com")
    page.click("#accessSubmit")
    page.wait_for_selector("#appRoot", state="visible")
    REQUESTED.clear()
    page.set_input_files("#reportInput", str(fixture / "daily_report.csv"))
    page.wait_for_selector("#reportSessions .session-pick", timeout=10000)
    picks = page.locator("#reportSessions .session-pick").count()
    downloads_before_pick = len(REQUESTED)
    page.locator(f'#reportSessions [data-session="{SESSION_B}"]').click()
    deadline = time.time() + 120
    vals = {}
    while time.time() < deadline:
        vals = episode_values(page)
        if all(k in vals and vals[k]["blue"] is not None for k in EXPECT):
            break
        page.wait_for_timeout(500)
    loaded = page.evaluate("ingested.sessionId")
    active = page.locator("#reportSessions .session-pick.active").inner_text()
    page.close()
    return {"picks": picks, "downloads_before_pick": downloads_before_pick, "loaded": loaded,
            "active": active, "vals": vals, "errors": errors, "requested": list(REQUESTED)}


def check(vals, c0=True):
    problems = []
    if c0:
        got = vals.get("__c0") or {}
        for item, want in EXPECT_C0.items():
            if got.get(item) != want:
                problems.append(f"C0 {item}: {got.get(item)} (want {want})")
    for ep, (blue, orange) in EXPECT.items():
        got = vals.get(ep)
        if not got:
            problems.append(f"{ep}: no episode form")
            continue
        if got["blue"] != blue or got["orange"] != orange:
            problems.append(f"{ep}: blue={got['blue']} orange={got['orange']} (want {blue}/{orange})")
    return problems


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    work = Path(tempfile.mkdtemp(prefix="zone_app_"))
    fixture = work / "blob"
    blob_port = free_port()
    subprocess.run([sys.executable, str(ROOT / "scripts" / "make_zone_fixture.py"), str(fixture),
                    "--base-url", f"http://127.0.0.1:{blob_port}"], check=True, stdout=subprocess.DEVNULL)
    serve(fixture, CorsHandler, blob_port)
    # Same files from a host that sends no CORS headers.
    nocors_port = free_port()
    serve(fixture, QuietStatic, nocors_port)
    build_daily_report(fixture, blob_port)
    report = (fixture / "inspection_report.csv").read_text()
    (fixture / "inspection_report_nocors.csv").write_text(
        report.replace(f"127.0.0.1:{blob_port}", f"127.0.0.1:{nocors_port}"))

    hosts = []
    if which in ("all", "public"):
        port = free_port()
        serve(ROOT, QuietStatic, port)
        hosts.append(("public", f"http://127.0.0.1:{port}/index.html", None))
    if which in ("all", "server"):
        port = free_port()
        proc = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "review_server.py"), "--port", str(port)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        hosts.append(("server", f"http://127.0.0.1:{port}/", proc))

    failures = 0
    cases = [(h, m) for h in hosts for m in ("files", "split", "report")]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for (name, url, _), mode in tqdm(cases, desc="app paths", unit="path"):
            vals, status, errors = run_case(browser, url, mode, fixture)
            problems = check(vals) + [f"page error: {e}" for e in errors]
            tag = "PASS" if not problems else "FAIL"
            failures += bool(problems)
            tqdm.write(f"[{tag}] {name}/{mode}: {json.dumps({k: (v['blue'], v['orange']) if k != '__c0' else v for k, v in vals.items()})}")
            tqdm.write(f"        status: {status}")
            for prob in problems:
                tqdm.write(f"        - {prob}")
        for name, url, _ in hosts:
            r = run_daily(browser, url, fixture)
            problems = check(r["vals"], c0=False) + [f"page error: {e}" for e in r["errors"]]
            if r["picks"] != 2:
                problems.append(f"expected 2 sessions to pick from, got {r['picks']}")
            if r["downloads_before_pick"]:
                problems.append(f"{r['downloads_before_pick']} file(s) downloaded before a session was picked")
            if r["loaded"] != SESSION_B:
                problems.append(f"loaded session {r['loaded']}, want {SESSION_B}")
            wrong = [p for p in r["requested"] if SESSION_A in p]
            if wrong:
                problems.append(f"downloaded the other session's files: {wrong}")
            failures += bool(problems)
            tqdm.write(f"[{'PASS' if not problems else 'FAIL'}] {name}/daily: {r['picks']} sessions, loaded {r['loaded']}, "
                       f"{len(r['requested'])} file(s) fetched, none from the other session" if not problems else
                       f"[FAIL] {name}/daily")
            for prob in problems:
                tqdm.write(f"        - {prob}")
        public = next((h for h in hosts if h[0] == "public"), None)
        if public:
            vals, status, errors = run_case(browser, public[1], "report", fixture, "inspection_report_nocors.csv")
            ok = "CORS" in status and not errors
            failures += not ok
            tqdm.write(f"[{'PASS' if ok else 'FAIL'}] public/no-cors: message names CORS")
            tqdm.write(f"        status: {status}")
        browser.close()
    for _, _, proc in hosts:
        if proc:
            proc.terminate()
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
