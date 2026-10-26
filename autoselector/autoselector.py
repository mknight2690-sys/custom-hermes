#!/usr/bin/env python3
"""Free-model Autoselector v3: OpenAI-compatible server on 127.0.0.1 (PORT env, default 8787; Custom Hermes uses 8788).
Uses a local JSON state file (state.json): model stats, cooldowns, tuning, free-model list persist across restarts.
No deferrals/aborts: deadline is unbounded, keys x models are cycled until a reply comes back; Pollinations is last resort."""
import json, os, time, threading, hashlib, random, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
HERE = os.path.dirname(os.path.abspath(__file__)); STATE = os.path.join(HERE, "state.json")
NOUS_URL = "https://inference-api.nousresearch.com/v1/chat/completions"
NOUS_REC = "https://portal.nousresearch.com/api/nous/recommended-models"
NOUS_MODELS = "https://inference-api.nousresearch.com/v1/models"
POLL_URL = "https://text.pollinations.ai/openai"
KEYFILES = ([os.environ["NOUS_KEYS_FILE"]] if os.environ.get("NOUS_KEYS_FILE") else []) + [os.path.join(HERE, "nous_keys.txt"), os.path.join(HERE,"nous_keys.local.txt")]
UA = {"User-Agent": "CustomHermes/1.0 python", "Accept": "application/json"}
# ---- local kv (replaces kt.db kv table) ----
_kvl = threading.Lock()
try: KV = json.load(open(STATE))
except Exception: KV = {}
def kv_get(k, d=None):
    with _kvl: return KV.get(k, d)
def kv_set(k, v):
    with _kvl:
        KV[k] = v; tmp = STATE + ".tmp"; json.dump(KV, open(tmp, "w")); os.replace(tmp, STATE)
def nous_keys():
    ks = []
    for p in KEYFILES:
        if os.path.exists(p): ks += [l.strip() for l in open(p) if l.strip() and not l.startswith("#")]
    for e in ("NOUS_API_KEY", "NOUS_FREE_KEY"):
        if os.environ.get(e): ks.append(os.environ[e].strip())
    return list(dict.fromkeys(ks))
def model_blacklist():
    p = os.path.join(HERE, "model_blacklist.txt")
    return {l.strip() for l in open(p) if l.strip() and not l.startswith("#")} if os.path.exists(p) else set()
def _truncated(r):
    try:
        ch = r["choices"][0]; msg = ch.get("message") or {}; fr = ch.get("finish_reason")
        calls = msg.get("tool_calls") or []
        if fr == "length": return "finish_reason=length"
        if fr is None: return "finish_reason=none"
        if not calls and not (msg.get("content") or "").strip(): return "empty"
        for tc in calls:
            json.loads((tc.get("function") or {}).get("arguments") or "{}")
            if not (tc.get("function") or {}).get("name"): return "toolcall-no-name"
    except Exception as e: return "bad:" + str(e)[:60]
    return None
class AIErr(RuntimeError):
    def __init__(s, status, msg, hdr=None):
        super().__init__(f"HTTP {status}: {msg[:160]}"); s.status, s.msg, s.hdr = status, msg, hdr or {}
def _post(url, key, body, timeout):
    h = {"Content-Type": "application/json", **UA}
    if key: h["Authorization"] = "Bearer " + key
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), h), timeout=timeout)
        return json.load(r), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        raise AIErr(e.code, e.read().decode("utf-8", "replace")[:300], {k.lower(): v for k, v in e.headers.items()})
def _nous_raw(key, model, messages, tools=None, max_tokens=1500, timeout=90, extra=None):
    body = {"temperature": 0.3, **(extra or {}), "model": model, "messages": messages, "max_tokens": max_tokens}
    if tools: body["tools"] = tools
    try: j, h = _post(NOUS_URL, key, body, timeout)
    except AIErr as e: _key_budget(key, e.hdr); raise
    _key_budget(key, h); return j
# ---- Autoselector v2/v3 state ----
WORKHORSE_DEFAULT = ["poolside/laguna-xs-2.1:free", "meituan/longcat-2.5-preview:free", "poolside/laguna-s-2.1:free"]
_now = time.time()
KEYCOOL = {}; MODELCOOL = {m: t for m, t in (kv_get("modelcool", {}) or {}).items() if t > _now}
MODELDEAD = {m: t for m, t in (kv_get("modeldead", {}) or {}).items() if t > _now}
KEYBUD = {}; AISTATS = (kv_get("ai_stats", {}) or {}).get("models", {}); _stats_flush = [0.0]; LAST_OK = [0.0]
KEYWIN = {}; KEYFLY = {}; KEYST = (kv_get("ai_stats", {}) or {}).get("keyst", {}); _kw_lock = threading.Lock()
def KEY_RPM_SOFT(): return int(kv_get("key_rpm_soft", 40) or 40)
def KEY_FLY_MAX(): return int(kv_get("key_fly_max", 2) or 2)
PRIO = {"live": 0, "paper": 1, "bot": 2, "medic": 3}
_gate = threading.Condition(); _gate_wait = []; _gate_fly = [0]; _gseq = [0]
def gate_cap(): return max(2, int(kv_get("ai_max_inflight", 0) or 0) or 2 * max(1, len(nous_keys())))
def _gate_enter(prio, deadline):
    with _gate:
        _gseq[0] += 1; me = (prio, time.time(), _gseq[0]); _gate_wait.append(me)
        try:
            def _room():
                cap = gate_cap(); res = max(2, len(nous_keys()))
                if prio == 0: return _gate_fly[0] < cap + res
                if prio == 1: return _gate_fly[0] < cap + res and min(_gate_wait) == me
                return _gate_fly[0] < max(1, cap - res) and min(_gate_wait) == me and not any(w[0] <= 1 for w in _gate_wait)
            while not _room(): _gate.wait(0.5)   # no deferrals: wait in queue as long as it takes
            _gate_fly[0] += 1
        finally: _gate_wait.remove(me); _gate.notify_all()
def _gate_exit():
    with _gate: _gate_fly[0] = max(0, _gate_fly[0] - 1); _gate.notify_all()
def _kload(k):
    now = time.time(); w = [t for t in KEYWIN.get(k, []) if now - t < 60]; KEYWIN[k] = w; return len(w)
def _kpick(ks): return sorted(ks, key=lambda k: (KEYFLY.get(k, 0), _kload(k), _key_score(k)))
def _kst(k, kind, ms=None):
    s = KEYST.setdefault(_kid(k), {"calls": 0, "ok": 0, "r429": 0, "err": 0, "ms": 0})
    s["calls"] += 1; s[kind] = s.get(kind, 0) + 1
    if ms is not None: s["ms"] = int(s["ms"] * 0.8 + ms * 0.2) if s["ms"] else int(ms)
def _mscore(m):
    s = AISTATS.get(m, {}); ok = s.get("ok", 0); bad = s.get("cap429", 0) + s.get("err", 0) + 2 * s.get("trunc", 0)
    return (ok + 1) / (ok + bad + 2) - min(s.get("ms", 0), 60000) / 120000
def _kid(k): return hashlib.sha256(k.encode()).hexdigest()[:8]
def _hf(h, n, d=None):
    try: return float(h.get(n))
    except Exception: return d
def _key_budget(key, h):
    if not h or _hf(h, "x-ratelimit-remaining-requests") is None: return
    now = time.time()
    KEYBUD[key] = {"rpm": _hf(h, "x-ratelimit-remaining-requests", 50), "rpm_reset": now + _hf(h, "x-ratelimit-reset-requests", 60),
                   "tpm": _hf(h, "x-ratelimit-remaining-tokens", 5e5), "tpm_reset": now + _hf(h, "x-ratelimit-reset-tokens", 60),
                   "rph": _hf(h, "x-ratelimit-remaining-requests-1h", 2100), "tph": _hf(h, "x-ratelimit-remaining-tokens-1h", 6e6),
                   "h_reset": now + _hf(h, "x-ratelimit-reset-tokens-1h", 3600), "ts": now}
def _key_ok(key, est):
    b = KEYBUD.get(key); now = time.time()
    if not b: return True
    if b["rpm"] < 1 and now < b["rpm_reset"]: return False
    if b["tpm"] < est and now < b["tpm_reset"]: return False
    if (b["rph"] < 1 or b["tph"] < est) and now < b["h_reset"]: return False
    return True
def _key_score(key):
    b = KEYBUD.get(key); return -(b["tph"] if b and time.time() < b["h_reset"] else 6e6)
def _flush(force=False):
    if not force and time.time() - _stats_flush[0] <= 30: return
    _stats_flush[0] = time.time()
    try:
        kv_set("ai_stats", {"ts": time.time(), "models": AISTATS,
            "keys": {_kid(k): {x: (round(v) if isinstance(v, float) else v) for x, v in b.items() if x in ("rpm", "rph", "tph")} for k, b in KEYBUD.items()},
            "cool": {m: round(t - time.time()) for m, t in MODELCOOL.items() if t > time.time()},
            "score": {m: round(_mscore(m), 3) for m in AISTATS}, "keyst": KEYST,
            "keyload": {_kid(k): {"rpm_local": _kload(k), "inflight": KEYFLY.get(k, 0), "cool": round(max(0, KEYCOOL.get(k, 0) - time.time()))} for k in nous_keys()},
            "queue": {"inflight": _gate_fly[0], "waiting": len(_gate_wait), "cap": gate_cap()}})
        kv_set("modelcool", {m: t for m, t in MODELCOOL.items() if t > time.time()})
        kv_set("modeldead", {m: t for m, t in MODELDEAD.items() if t > time.time()})
    except Exception: pass
def _stat(model, kind, ms=None):
    st = AISTATS.setdefault(model, {"ok": 0, "cap429": 0, "key429": 0, "trunc": 0, "bad4xx": 0, "err": 0, "ms": 0})
    st[kind] = st.get(kind, 0) + 1
    if ms is not None and kind == "ok": st["ms"] = int(st["ms"] * 0.8 + ms * 0.2) if st["ms"] else int(ms)
    _flush()
def workhorses(): return kv_get("workhorse_models") or WORKHORSE_DEFAULT
def model_order(prefer=None):
    bl = model_blacklist(); free = free_models(); now = time.time()
    wh = sorted([m for m in workhorses() if m in free], key=lambda m: -_mscore(m))
    rest = sorted([m for m in free if m not in wh], key=lambda m: -_mscore(m))
    return [m for m in dict.fromkeys(wh + ([prefer] if prefer else []) + rest) if m not in bl and MODELDEAD.get(m, 0) < now]
_FM = {"ts": 0.0, "ids": []}; _fml = threading.Lock()
def free_models():
    if _FM["ids"] and time.time() - _FM["ts"] < 600: return _FM["ids"]
    with _fml:
        if _FM["ids"] and time.time() - _FM["ts"] < 600: return _FM["ids"]
        ids = []
        try:
            j = json.load(urllib.request.urlopen(urllib.request.Request(NOUS_REC, headers=UA), timeout=15)); fr = j.get("freeRecommendedModels") or []
            fr.sort(key=lambda m: m.get("position", 99)); ids = [m["modelName"] for m in fr if m.get("modelName")]
        except Exception: pass
        if not ids:   # local addition: fall back to the inference /models list (":free" ids)
            try: ids = [m["id"] for m in json.load(urllib.request.urlopen(urllib.request.Request(NOUS_MODELS, headers=UA), timeout=15))["data"] if m["id"].endswith(":free")]
            except Exception: pass
        if ids:
            old = set(_FM["ids"]); _FM.update(ts=time.time(), ids=ids)
            kv_set("free_models_seen", sorted(set(ids) | set(kv_get("free_models_seen", []))))
            kv_set("free_models_live", {"ts": time.time(), "ids": ids, "added": sorted(set(ids) - old) if old else [], "dropped": sorted(old - set(ids))})
            return ids
        _FM["ts"] = time.time() - 480
        return _FM["ids"] or (kv_get("free_models_live", {}) or {}).get("ids") or kv_get("free_models_seen", []) or ["tencent/hy3:free"]
_PM = {"ts": 0, "ids": ["openai", "openai-fast", "mistral"]}
def _pollinations(messages, tools, max_tokens, extra):
    if time.time() - _PM["ts"] > 3600:
        _PM["ts"] = time.time()
        try: _PM["ids"] = [m["name"] for m in json.load(urllib.request.urlopen(urllib.request.Request("https://text.pollinations.ai/models", headers=UA), timeout=15)) if not m.get("tier") or m.get("tier") == "anonymous"] or _PM["ids"]
        except Exception: pass
    for pm in _PM["ids"]:
        if MODELCOOL.get("poll:" + pm, 0) > time.time(): continue
        body = {**(extra or {}), "model": pm, "messages": messages, "max_tokens": max_tokens}
        if tools: body["tools"] = tools
        try:
            r, _ = _post(POLL_URL, None, body, 120)
            if not _truncated(r): _stat("poll:" + pm, "ok"); return r, "pollinations/" + pm
            _stat("poll:" + pm, "trunc")
        except AIErr as e: MODELCOOL["poll:" + pm] = time.time() + (min(max(_hf(e.hdr, "retry-after", 60) or 60, 5), 300) if e.status == 429 else 60); _stat("poll:" + pm, "err")
        except Exception: MODELCOOL["poll:" + pm] = time.time() + 30; _stat("poll:" + pm, "err")
    return None
def ai_chat(messages, tools=None, prefer=None, max_tokens=1500, timeout=90, prio="paper", extra=None):
    ks = nous_keys()
    est = int(len(json.dumps(messages)) / 3.5) + max_tokens + (len(json.dumps(tools)) // 4 if tools else 0)
    p = PRIO.get(prio, 1) if isinstance(prio, str) else int(prio)
    _gate_enter(p, float("inf"))
    try: return _ai_chat_inner(messages, tools, prefer, ks, est, max_tokens, timeout, p, extra)
    finally: _gate_exit()
def _ai_chat_inner(messages, tools, prefer, ks, est, max_tokens, timeout, prio=1, extra=None):
    while True:
        models = model_order(prefer) if ks else []
        for m in models:
            if MODELCOOL.get(m, 0) > time.time(): continue
            mt = max_tokens
            for k in _kpick(ks):
                if KEYCOOL.get(k, 0) > time.time() or not _key_ok(k, est) or KEYFLY.get(k, 0) >= KEY_FLY_MAX() or _kload(k) >= (48 if prio == 0 else KEY_RPM_SOFT()): continue
                t0 = time.time()
                with _kw_lock: KEYWIN.setdefault(k, []).append(t0); KEYFLY[k] = KEYFLY.get(k, 0) + 1
                try:
                    r = _nous_raw(k, m, messages, tools, mt, timeout, extra); _kst(k, "ok", (time.time() - t0) * 1000)
                except AIErr as e:
                    _kst(k, "r429" if e.status == 429 else "err")
                    txt = e.msg.lower(); ra = _hf(e.hdr, "retry-after", None)
                    if e.status == 429 and ("capacity" in txt or "not your api key" in txt or "upstream" in txt):
                        MODELCOOL[m] = time.time() + min(max(ra or 30, 5), 120); _stat(m, "cap429"); break
                    if e.status == 429:
                        KEYCOOL[k] = time.time() + min(max(ra or _hf(e.hdr, "x-ratelimit-reset-requests", 20) or 20, 3), 90); _stat(m, "key429"); continue
                    if e.status in (401, 403): KEYCOOL[k] = time.time() + 600; continue   # local: bad/unauthorised key -> rest it, keep cycling
                    if e.status in (400, 404, 422): print(time.ctime(), "bad4xx", m, e.status, e.msg[:200], flush=True)
                    if e.status in (400, 404, 422): MODELDEAD[m] = time.time() + 3600; _stat(m, "bad4xx"); break
                    MODELCOOL[m] = time.time() + 30; _stat(m, "err"); break
                except Exception:
                    _kst(k, "err"); MODELCOOL[m] = time.time() + 20; _stat(m, "err"); break
                finally:
                    with _kw_lock: KEYFLY[k] = max(0, KEYFLY.get(k, 1) - 1)
                bad = _truncated(r)
                if bad == "finish_reason=length" and mt < 4096: _stat(m, "trunc"); mt = min(4096, mt * 2); continue
                if bad:
                    kv_set("trunc_events", (kv_get("trunc_events", []) + [[time.time(), m, bad]])[-100:])
                    MODELCOOL[m] = time.time() + 60; _stat(m, "trunc"); break
                LAST_OK[0] = time.time(); _stat(m, "ok", (time.time() - t0) * 1000)
                return r, m
        # every Nous key x model is cooling/failed this pass -> last resort Pollinations, then keep cycling (never give up)
        pr = _pollinations(messages, tools, max_tokens, extra)
        if pr: return pr
        waits = [t for t in list(MODELCOOL.values()) + list(KEYCOOL.values()) if t > time.time()] + [min(KEYWIN[k]) + 60 for k in ks if _kload(k) >= KEY_RPM_SOFT() and KEYWIN.get(k)]
        wake = min(waits) if waits else time.time() + 2
        step = 2.0 if prio == 0 else (4.0 if prio == 1 else 15.0)
        time.sleep(max(0.5, min(wake - time.time(), step)) + random.random() * 0.5)
PASS = ("temperature", "top_p", "stop", "tool_choice", "response_format", "presence_penalty", "frequency_penalty", "seed")
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _s(self, code, obj):
        o = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(o))); self.end_headers(); self.wfile.write(o)
    def do_GET(self):
        if not any(self.path.rstrip("/").endswith(x) for x in ("/models", "/health")): return self._s(404, {"error": {"message": "not found"}})
        if self.path.rstrip("/").endswith("/health"): return self._s(200, kv_get("ai_stats", {}))
        self._s(200, {"object": "list", "data": [{"id": "auto", "object": "model", "owned_by": "autoselector"}] + [{"id": i, "object": "model"} for i in free_models()]})
    def do_POST(self):
        try: body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        except Exception: return self._s(400, {"error": {"message": "bad json"}})
        if not self.path.rstrip("/").endswith("chat/completions"): return self._s(404, {"error": {"message": "not found"}})
        if not body.get("messages"): return self._s(400, {"error": {"message": "messages is required"}})
        want = body.get("model") or "auto"; prefer = None if want in ("auto", "", None) else want
        prio = "live" if self.headers.get("x-priority","").lower()=="live" else "bot"
        mt = int(body.get("max_tokens") or body.get("max_completion_tokens") or 1500)
        extra = {k: body[k] for k in PASS if k in body}
        r, m = ai_chat(body.get("messages") or [], body.get("tools"), prefer, mt, 90, prio, extra)
        r = dict(r); r["model"] = m; r.setdefault("object", "chat.completion"); r.setdefault("id", "as-%d" % int(time.time()*1000))
        if body.get("stream"):   # minimal SSE for streaming clients
            msg = r["choices"][0].get("message") or {}; ch = {"id": r["id"], "object": "chat.completion.chunk", "model": m,
                "choices": [{"index": 0, "delta": {k: ([{**tc, "index": i} for i, tc in enumerate(v)] if k == "tool_calls" else v) for k, v in msg.items() if v is not None}, "finish_reason": r["choices"][0].get("finish_reason")}]}
            o = ("data: " + json.dumps(ch) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("content-length", str(len(o))); self.end_headers(); self.wfile.write(o); return
        self._s(200, r)
    def log_message(self, *a): pass
if __name__ == "__main__":
    print(time.ctime(), "autoselector v3 keys=%d models=%d" % (len(nous_keys()), len(free_models())), flush=True)
    threading.Thread(target=lambda: [(_flush(True), time.sleep(30)) for _ in iter(int, 1)], daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", 8787))), H).serve_forever()

