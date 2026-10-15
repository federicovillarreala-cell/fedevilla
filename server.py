"""Gridiron IQ server: serves the app, relays ESPN Fantasy league requests and keeps your setup.

It runs in two places:
- On your PC (the default): reachable from phones on the same Wi-Fi. Whoever sits at this PC
  (localhost) is the owner.
- In the cloud (GIQ_CLOUD=1, or detected on Render/Fly/Railway): reachable from anywhere over HTTPS.
  There is no "localhost = owner" there, so the owner proves it with a passcode (the GIQ_PASSCODE
  setting on the host, 8+ characters). Strangers who find the URL can use the public parts of the
  app but can never read your saved setup (it holds your ESPN espn_s2 / SWID cookies).

- /espn/...      ESPN private leagues need your espn_s2 / SWID cookies, which a browser page can't
                 attach to espn.com requests itself, so the page sends them here and this relay
                 forwards them. Only the ESPN fantasy football API is reachable through it.
- /api/info      whether this is the cloud copy, its public address, and (on the PC) the linked cloud app.
- /api/lan       the addresses a phone on the same network can use to open the app (PC only).
- /api/login     cloud only: the owner passcode turns this device into a trusted one ("device pass",
                 a 1-year cookie) and returns the saved setup. Wrong guesses are slowed down and locked out.
- /api/pair      the owner (this PC, or a trusted device in the cloud) stores its setup and gets a
                 6-digit code; another device posts the code to /api/claim to copy it. Codes are
                 single-use, expire after 10 minutes and lock after 5 wrong guesses, so nothing
                 sensitive ever travels in a URL. A successful claim also gives a device pass.
- /api/setup     remembers your setup (in .giq-setup.json) so you never have to sign in again.
                 Readable/writable only by the owner or a device holding a device pass.
- /api/cloud     PC only: logs in to your cloud copy with its passcode and sends it your setup,
                 then keeps it updated whenever your setup changes here.
"""
import hashlib
import hmac
import http.cookies
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
ESPN = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT") or 5190)
HOST = os.environ.get("GIQ_HOST", "0.0.0.0")  # 0.0.0.0 = reachable from your phone on the same Wi-Fi
CLOUD = any(os.environ.get(k) for k in ("GIQ_CLOUD", "RENDER", "FLY_APP_NAME", "RAILWAY_ENVIRONMENT"))
PASSCODE = os.environ.get("GIQ_PASSCODE", "").strip()
PASSCODE_OK = len(PASSCODE) >= 8
# device passes in the cloud are signed rather than stored, so they survive restarts on hosts
# without a disk; changing the passcode (or GIQ_SECRET) signs every device out
SECRET = (os.environ.get("GIQ_SECRET") or ("giq-device|" + PASSCODE)).encode()
PUBLIC_URL = (os.environ.get("GIQ_PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").rstrip("/")
PAIR_TTL = 600
LOGIN_WINDOW, LOGIN_MAX_MISSES = 900, 8
STATIC_EXT = {".html", ".js", ".css", ".png", ".svg", ".ico", ".webmanifest"}

pairing = {"code": None, "data": None, "expires": 0, "misses": 0}
login_misses = []
DATA_DIR = os.environ.get("GIQ_DATA_DIR") or ROOT
SETUP_FILE = os.path.join(DATA_DIR, ".giq-setup.json")
DEVICE_COOKIE = "giq_device"
store_lock = threading.Lock()


def load_store():
    try:
        with open(SETUP_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return {"cfg": data.get("cfg"), "devices": data.get("devices") or {}, "cloud": data.get("cloud")}
    except (OSError, ValueError):
        return {"cfg": None, "devices": {}, "cloud": None}


def save_store(store):
    tmp = SETUP_FILE + ".tmp"
    with store_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(store, f)
        os.replace(tmp, SETUP_FILE)


def sign_device():
    nonce = secrets.token_urlsafe(18)
    return f"c.{nonce}.{hmac.new(SECRET, nonce.encode(), hashlib.sha256).hexdigest()[:40]}"


def signed_device_ok(token):
    parts = token.split(".")
    if not PASSCODE_OK or len(parts) != 3 or parts[0] != "c":
        return False
    want = hmac.new(SECRET, parts[1].encode(), hashlib.sha256).hexdigest()[:40]
    return secrets.compare_digest(parts[2], want)


def lan_ips():
    if CLOUD:
        return []
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the outbound interface
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def cloud_call(base, path, payload, device=None):
    headers = {"Content-Type": "application/json", "User-Agent": "GridironIQ-PC"}
    if device:
        headers["X-Giq-Device"] = device
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:  # free hosts can take ~1 min to wake up
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def push_to_cloud(store):
    cloud = store.get("cloud") or {}
    if cloud.get("url") and cloud.get("device"):
        try:
            cloud_call(cloud["url"], "/api/setup", {"cfg": store["cfg"]}, cloud["device"])
        except Exception:
            pass  # offline or asleep; the next change will try again


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json", ".js": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if CLOUD:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        super().end_headers()

    def send_json(self, code, obj, cookie=None):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            secure = "; Secure" if CLOUD else ""
            self.send_header("Set-Cookie", f"{DEVICE_COOKIE}={cookie}; Max-Age=31536000; Path=/; SameSite=Strict; HttpOnly{secure}")
        self.end_headers()
        self.wfile.write(body)

    def is_local(self):
        # in the cloud every request arrives through the host's proxy, so the address proves nothing
        return not CLOUD and self.client_address[0] in ("127.0.0.1", "::1")

    def device_token(self):
        token = self.headers.get("X-Giq-Device", "").strip()
        if not token:
            jar = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
            token = jar[DEVICE_COOKIE].value if DEVICE_COOKIE in jar else ""
        return token

    def trusted(self, store):
        token = self.device_token()
        if self.is_local():
            return True
        if not token:
            return False
        return signed_device_ok(token) if CLOUD else token in store["devices"]

    def new_device(self, store):
        if CLOUD:
            return sign_device()
        token = secrets.token_urlsafe(24)
        store["devices"][token] = {"added": int(time.time()), "agent": self.headers.get("User-Agent", "")[:120]}
        return token

    def public_url(self):
        if PUBLIC_URL:
            return PUBLIC_URL
        proto = self.headers.get("X-Forwarded-Proto", "https" if CLOUD else "http").split(",")[0].strip()
        return f"{proto}://{self.headers.get('Host', '')}"

    def read_json(self):
        n = min(int(self.headers.get("Content-Length") or 0), 64_000)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def do_GET(self):
        path = self.path.split("?")[0]
        if any(part.startswith(".") for part in path.split("/")):
            return self.send_json(404, {"error": "not found"})  # never serve the saved setup file
        if path == "/api/setup":
            store = load_store()
            if not self.trusted(store):
                return self.send_json(401, {"error": "This device isn't paired yet."})
            return self.send_json(200, {"cfg": store["cfg"]})
        if path == "/api/info":
            info = {"cloud": CLOUD, "passcode": PASSCODE_OK, "publicUrl": self.public_url() if CLOUD else None}
            if self.is_local():
                info["cloudUrl"] = (load_store().get("cloud") or {}).get("url")
            return self.send_json(200, info)
        if path == "/api/lan":
            return self.send_json(200, {"port": PORT, "ips": lan_ips() if HOST == "0.0.0.0" else []})
        if not self.path.startswith("/espn/"):
            if path != "/" and os.path.splitext(path)[1].lower() not in STATIC_EXT:
                return self.send_json(404, {"error": "not found"})  # only the app's own files are public
            return super().do_GET()
        url = ESPN + self.path[len("/espn/"):]
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        s2, swid = self.headers.get("X-Espn-S2", "").strip(), self.headers.get("X-Swid", "").strip()
        if s2 and swid:
            headers["Cookie"] = f"espn_s2={s2}; SWID={swid}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as r:
                code, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, body = e.code, e.read() or b"{}"
        except Exception as e:  # network trouble
            code, body = 502, json.dumps({"messages": [str(e)]}).encode()
        self.send_json(code, body)

    def do_HEAD(self):
        path = self.path.split("?")[0]
        if path != "/" and os.path.splitext(path)[1].lower() not in STATIC_EXT:
            return self.send_json(404, {"error": "not found"})
        return super().do_HEAD()

    def do_POST(self):
        if self.path == "/api/setup":
            store = load_store()
            if not self.trusted(store):
                return self.send_json(401, {"error": "This device isn't paired yet."})
            body = self.read_json()
            if not isinstance(body, dict) or not isinstance(body.get("cfg"), (dict, type(None))):
                return self.send_json(400, {"error": "bad request"})
            store["cfg"] = body["cfg"]
            save_store(store)
            if not CLOUD:
                threading.Thread(target=push_to_cloud, args=(store,), daemon=True).start()
            return self.send_json(200, {"ok": True})
        if self.path == "/api/login":
            if not CLOUD or not PASSCODE_OK:
                return self.send_json(403, {"error": "No owner passcode is set up on the server yet."})
            now = time.time()
            login_misses[:] = [t for t in login_misses if now - t < LOGIN_WINDOW]
            if len(login_misses) >= LOGIN_MAX_MISSES:
                return self.send_json(429, {"error": "Too many wrong tries. Wait 15 minutes and try again."})
            body = self.read_json() or {}
            if not secrets.compare_digest(str(body.get("passcode", "")).strip().encode(), PASSCODE.encode()):
                login_misses.append(now)
                time.sleep(1)
                return self.send_json(401, {"error": "Wrong passcode."})
            token = sign_device()
            return self.send_json(200, {"device": token, "cfg": load_store()["cfg"]}, cookie=token)
        if self.path == "/api/pair":
            owner = self.trusted(load_store()) if CLOUD else self.is_local()
            if not owner:
                return self.send_json(403, {"error": "Pairing codes can only be created by the app's owner."})
            data = self.read_json()
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad request"})
            pairing.update(code=f"{secrets.randbelow(1_000_000):06d}", data=data, expires=time.time() + PAIR_TTL, misses=0)
            return self.send_json(200, {"code": pairing["code"], "ttl": PAIR_TTL})
        if self.path == "/api/claim":
            body = self.read_json() or {}
            ok = pairing["code"] and time.time() < pairing["expires"] and pairing["misses"] < 5
            if ok and secrets.compare_digest(str(body.get("code", "")), pairing["code"]):
                data = pairing["data"]
                pairing.update(code=None, data=None, expires=0)
                store = load_store()
                token = self.new_device(store)
                if data:
                    store["cfg"] = data
                save_store(store)
                return self.send_json(200, {"cfg": data, "device": token}, cookie=token)
            pairing["misses"] += 1
            return self.send_json(400, {"error": "That code didn't work. Make a new one."})
        if self.path == "/api/cloud":
            if not self.is_local():
                return self.send_json(403, {"error": "Only the computer running the app can link a cloud copy."})
            body = self.read_json() or {}
            url = str(body.get("url", "")).strip().rstrip("/")
            if url and "://" not in url:
                url = "https://" + url
            if not url.startswith("https://"):
                return self.send_json(400, {"error": "Paste the https:// address of your cloud app."})
            try:
                code, j = cloud_call(url, "/api/login", {"passcode": body.get("passcode", "")})
            except Exception as e:
                return self.send_json(502, {"error": f"Couldn't reach {url} ({e}). Check the address."})
            if code != 200 or not j.get("device"):
                return self.send_json(400, {"error": j.get("error") or f"The cloud app answered with error {code}."})
            store = load_store()
            store["cloud"] = {"url": url, "device": j["device"]}
            save_store(store)
            if store["cfg"]:
                cloud_call(url, "/api/setup", {"cfg": store["cfg"]}, j["device"])
            return self.send_json(200, {"ok": True, "url": url, "sent": bool(store["cfg"])})
        self.send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        if not self.path.startswith("/espn/"):  # only log relay calls (URLs carry no cookies)
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    if CLOUD:
        print(f"Gridiron IQ (cloud) listening on port {PORT}")
        if not PASSCODE_OK:
            print("  WARNING: set GIQ_PASSCODE (8+ characters) so you can unlock your saved setup.")
    else:
        print(f"Gridiron IQ running at http://localhost:{PORT}  (Ctrl+C to stop)")
        for ip in lan_ips() if HOST == "0.0.0.0" else []:
            print(f"  On your phone (same Wi-Fi): http://{ip}:{PORT}")
    http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
