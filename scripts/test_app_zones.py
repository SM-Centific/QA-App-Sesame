#!/usr/bin/env python3
"""Browser check: Blue/Orange Zone are filled on the episode forms.

Builds the zone fixture (episode 1 in front, episode 2 to the side), then
drives the real page in headless Chromium through each input path:

  * public  / files   - static hosting (like GitHub Pages), files dropped by hand
  * public  / report  - static hosting, inspection CSV uploaded
  * server  / files   - review_server.py running, files dropped by hand
  * server  / report  - review_server.py running, inspection CSV uploaded
  * public  / no-cors - static hosting, blob host without CORS: expect a clear
                        message naming CORS instead of silent empty scores

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
EXPECT = {  # episodeId -> (blue %, orange %)
    "ep-1": (100.0, 0.0),
    "ep-2": (0.0, 100.0),
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CorsHandler(http.server.SimpleHTTPRequestHandler):
    """Static files with the CORS headers Azure Blob sends once CORS is enabled."""

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
          blue: f.values.blue_zone_pct, orange: f.values.orange_zone,
          blueNote: f.autos.blue_zone_pct && f.autos.blue_zone_pct.note };
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
    if mode == "files":
        files = [str(fixture / f"{STEM}{ext}") for ext in
                 (".mmwave.bin", ".episode_markers.jsonl", ".mmwave_sync.json", ".capture.json")]
        page.set_input_files("#fileInput", files)
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


def check(vals):
    problems = []
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
    cases = [(h, m) for h in hosts for m in ("files", "report")]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for (name, url, _), mode in tqdm(cases, desc="app paths", unit="path"):
            vals, status, errors = run_case(browser, url, mode, fixture)
            problems = check(vals) + [f"page error: {e}" for e in errors]
            tag = "PASS" if not problems else "FAIL"
            failures += bool(problems)
            tqdm.write(f"[{tag}] {name}/{mode}: {json.dumps({k: (v['blue'], v['orange']) for k, v in vals.items()})}")
            tqdm.write(f"        status: {status}")
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
