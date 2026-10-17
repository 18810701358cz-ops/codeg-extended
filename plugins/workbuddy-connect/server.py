# -*- coding: utf-8 -*-
"""
WorkBuddy to OpenAI API Bridge for Codeg & other AI tools.
- 自动提取并解密本地 WorkBuddy 凭据
- 提供 OpenAI 标准接口 (/v1/models, /v1/chat/completions)
- 支持模型倍率与优惠标签解析 (credits & badges)
- 支持完整的推理档位探测服务 (Reasoning Effort Probe)
- 提供可视化 Web 仪表盘 (http://127.0.0.1:18080)
"""

import os
import sys
import json
import base64
import hashlib
import struct
import uuid
import time
import logging
import threading
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("WorkBuddyBridge")

PORT = int(os.environ.get("PORT", "18080"))
HOST = os.environ.get("HOST", "127.0.0.1")

DEFAULT_AUTH_PATH = os.path.expandvars(r"%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info")
DEFAULT_EXE_PATH = os.path.expandvars(r"%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe")
PROBE_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".workbuddy-probe-cache.json")

class WorkBuddyAuth:
    def __init__(self, auth_path=DEFAULT_AUTH_PATH, exe_path=DEFAULT_EXE_PATH):
        self.auth_path = auth_path
        self.exe_path = exe_path
        self.cached_token = None
        self.cached_account = {}
        self.last_read_mtime = 0
        self.protector_key = None

    def _resolve_protector_key(self):
        if self.protector_key:
            return self.protector_key
        
        if not os.path.exists(self.exe_path):
            logger.error(f"WorkBuddy.exe not found at {self.exe_path}")
            return None

        import subprocess
        env = dict(os.environ)
        env["ELECTRON_RUN_AS_NODE"] = "1"
        script = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'
        
        try:
            p = subprocess.run([self.exe_path, "-e", script], env=env, capture_output=True, text=True, timeout=10)
            if p.returncode == 0 and p.stdout:
                payload = json.loads(p.stdout)
                secret_key_str = payload.get("atRestSecretKey", "")
                if secret_key_str:
                    self.protector_key = hashlib.sha256(secret_key_str.encode("utf-8")).digest()
                    logger.info("Successfully derived protector key from WorkBuddy Electron")
                    return self.protector_key
            logger.error(f"Failed to extract secret key (code {p.returncode}): {p.stderr}")
        except Exception as e:
            logger.error(f"Exception when running WorkBuddy helper: {e}")
        return None

    def _build_aad(self, key_id: str, suite: int = 1) -> bytes:
        prefix = b"WB-AAD\x00"
        def lp(s: str) -> bytes:
            b = s.encode("utf-8")
            return struct.pack(">I", len(b)) + b
        return prefix + bytes([1]) + lp("WBEV1") + lp("sym-v1") + struct.pack(">I", suite) + lp(key_id) + bytes([2, 0, 0])

    def _decrypt_field(self, field_val) -> str:
        if isinstance(field_val, str):
            return field_val
        if isinstance(field_val, dict) and field_val.get("$wbEncrypted") == 1:
            key = self._resolve_protector_key()
            if not key:
                raise RuntimeError("Failed to resolve protector key from WorkBuddy")
            
            env_raw = base64.b64decode(field_val["envelope"])
            env_data = json.loads(env_raw)
            suite = env_data["suite"]
            key_id = env_data["keyId"]
            nonce = base64.b64decode(env_data["nonce"])
            auth_tag = base64.b64decode(env_data["authTag"])
            ciphertext = base64.b64decode(env_data["ciphertext"])
            aad = self._build_aad(key_id, suite)
            
            aesgcm = AESGCM(key)
            return aesgcm.decrypt(nonce, ciphertext + auth_tag, aad).decode("utf-8")
        return ""

    def get_credentials(self):
        if not os.path.exists(self.auth_path):
            raise FileNotFoundError(f"Auth file not found: {self.auth_path}. Please sign in to WorkBuddy first.")
        
        mtime = os.path.getmtime(self.auth_path)
        if self.cached_token and mtime == self.last_read_mtime:
            return self.cached_token, self.cached_account

        with open(self.auth_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        auth_obj = data.get("auth", {})
        account_obj = data.get("account", {})
        
        access_token = self._decrypt_field(auth_obj.get("accessToken"))
        uid = account_obj.get("uid", "") or auth_obj.get("uid", "")
        enterprise_id = account_obj.get("enterpriseId", "") or auth_obj.get("enterpriseId", "")
        domain = auth_obj.get("domain", "")

        self.cached_token = access_token
        self.cached_account = {
            "uid": uid,
            "enterpriseId": enterprise_id,
            "domain": domain,
            "nickname": account_obj.get("nickname", "WorkBuddy User"),
            "uin": account_obj.get("uin", ""),
            "expiresAt": auth_obj.get("expiresAt", 0)
        }
        self.last_read_mtime = mtime
        logger.info(f"Loaded credentials (UID: {uid or 'anonymous'}, Domain: {domain})")
        return self.cached_token, self.cached_account

auth_manager = WorkBuddyAuth()

def build_upstream_headers(access_token: str, account: dict) -> dict:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://www.codebuddy.cn",
        "Referer": "https://www.codebuddy.cn/",
        "User-Agent": "WorkBuddy/5.5.6 WorkBuddy/5.5.6",
        "X-Requested-With": "XMLHttpRequest",
        "X-IDE-Type": "WorkBuddy",
        "X-IDE-Name": "WorkBuddy",
        "X-IDE-Version": "5.5.6",
        "X-Product": "SaaS",
        "X-Conversation-ID": str(uuid.uuid4()),
        "X-Conversation-Request-ID": str(uuid.uuid4()),
        "X-Conversation-Message-ID": str(uuid.uuid4()),
    }
    if account.get("uid"):
        headers["X-User-Id"] = str(account["uid"])
    if account.get("enterpriseId"):
        headers["X-Enterprise-Id"] = str(account["enterpriseId"])
        headers["X-Tenant-Id"] = str(account["enterpriseId"])
    return headers

class ModelService:
    def __init__(self):
        self.cached_models = []
        self.last_fetch = 0
        self.probe_cache = {}
        self._load_probe_cache()

    def _load_probe_cache(self):
        if os.path.exists(PROBE_CACHE_PATH):
            try:
                with open(PROBE_CACHE_PATH, "r", encoding="utf-8") as f:
                    self.probe_cache = json.load(f)
            except Exception:
                self.probe_cache = {}

    def _save_probe_cache(self):
        try:
            with open(PROBE_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(self.probe_cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Failed to save probe cache: {e}")

    def fetch_models_with_billing(self):
        now = time.time()
        if self.cached_models and (now - self.last_fetch < 120):
            return self.cached_models

        token, account = auth_manager.get_credentials()
        headers = build_upstream_headers(token, account)

        # 1. 获取模型基本配置
        req_cfg = urllib.request.Request("https://copilot.tencent.com/v3/config", headers=headers)
        with urllib.request.urlopen(req_cfg, timeout=10) as resp:
            cfg_data = json.loads(resp.read().decode("utf-8")).get("data", {})

        raw_models = cfg_data.get("models", [])

        # 2. 获取控制台模型倍率与 Tags (badge:限时免费, badge:夜间折扣 等)
        billing_map = {}
        try:
            req_console = urllib.request.Request("https://copilot.tencent.com/console/enterprises/personal/models", headers=headers)
            with urllib.request.urlopen(req_console, timeout=10) as resp:
                con_data = json.loads(resp.read().decode("utf-8"))
                con_models = (con_data.get("data") or con_data).get("models", [])
                for cm in con_models:
                    cid = cm.get("id")
                    if cid:
                        billing_map[cid] = {
                            "credits": cm.get("credits"),
                            "tags": cm.get("tags") or []
                        }
        except Exception as e:
            logger.warning(f"Could not fetch billing badges: {e}")

        enriched = []
        for m in raw_models:
            mid = m.get("id")
            if not mid or m.get("disabled") is True:
                continue

            b_info = billing_map.get(mid, {})
            raw_credits = b_info.get("credits") or m.get("credits")
            # 格式化倍率，如 "x0.00", "x0.79"
            credits_str = ""
            if raw_credits:
                clean_cr = raw_credits.replace("credits", "").strip()
                credits_str = clean_cr

            # 提取 badges
            badges = []
            for tag in (b_info.get("tags") or []):
                if isinstance(tag, str) and tag.startswith("badge:"):
                    parts = tag.split(":")
                    if len(parts) >= 2:
                        badges.append(parts[1])

            is_free = (credits_str == "x0.00" or "限时免费" in badges)

            # 组合展示名称
            tag_display = []
            if credits_str:
                tag_display.append(credits_str)
            if "限时免费" in badges:
                tag_display.append("免")
            elif badges:
                tag_display.append(badges[0])

            suffix = f" [{' '.join(tag_display)}]" if tag_display else ""
            display_name = f"{m.get('name', mid)}{suffix}"

            enriched.append({
                "id": mid,
                "name": display_name,
                "raw_name": m.get("name", mid),
                "credits": credits_str,
                "badges": badges,
                "free": is_free,
                "maxInputTokens": m.get("maxInputTokens", 0),
                "maxOutputTokens": m.get("maxOutputTokens", 0),
                "supportsImages": m.get("supportsImages", False),
                "probed": self.probe_cache.get(mid)
            })

        self.cached_models = enriched
        self.last_fetch = now
        return self.cached_models

    def probe_model_effort(self, model_id: str):
        """探测模型的推理档位 (Reasoning Effort Probe)"""
        token, account = auth_manager.get_credentials()
        CANDIDATES = ["low", "medium", "high", "xhigh", "max"]

        def send_attempt(effort=None):
            headers = build_upstream_headers(token, account)
            payload = {
                "model": model_id,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
                "stream": True
            }
            if effort is not None:
                payload["reasoning_effort"] = effort

            req = urllib.request.Request(
                "https://copilot.tencent.com/v2/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers=headers
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    line = resp.readline().decode("utf-8", errors="ignore")
                    streamed = ("data:" in line) or (": heartbeat" in line)
                    return {"status": resp.status, "streamed": streamed}
            except urllib.error.HTTPError as e:
                err_text = e.read().decode("utf-8", errors="ignore")
                return {"status": e.code, "streamed": False, "error": err_text}
            except Exception as e:
                return {"status": 0, "streamed": False, "error": str(e)}

        # 1. Baseline
        base_res = send_attempt()
        if not base_res.get("streamed"):
            res = {
                "model": model_id,
                "validating": "unknown",
                "supported_efforts": [],
                "reason": f"Baseline failed: {base_res.get('error', 'unknown error')}",
                "timestamp": int(time.time())
            }
            self.probe_cache[model_id] = res
            self._save_probe_cache()
            return res

        # 2. Sentinel: 哨兵测试（非法值测试上游是否严格校验参数）
        sentinel_effort = f"probe_sentinel_{uuid.uuid4().hex[:10]}"
        sentinel_res = send_attempt(sentinel_effort)
        
        # 如果哨兵值也返回流式，说明上游完全不校验该参数 (non-validating)
        if sentinel_res.get("streamed"):
            res = {
                "model": model_id,
                "validating": "non-validating",
                "supported_efforts": [],
                "description": "上游未开启推理档位校验（参数不影响模型行为）",
                "timestamp": int(time.time())
            }
            self.probe_cache[model_id] = res
            self._save_probe_cache()
            return res

        # 3. Level Sweep: 依次探测各个真实档位
        passed_efforts = []
        for eff in CANDIDATES:
            eff_res = send_attempt(eff)
            if eff_res.get("streamed"):
                passed_efforts.append(eff)

        res = {
            "model": model_id,
            "validating": "validating",
            "supported_efforts": passed_efforts,
            "description": f"支持档位: {', '.join(passed_efforts)}" if passed_efforts else "未通过任何档位测试",
            "timestamp": int(time.time())
        }
        self.probe_cache[model_id] = res
        self._save_probe_cache()
        return res

model_service = ModelService()

def normalize_chat_body(data: dict) -> dict:
    payload = dict(data)
    payload["stream"] = True
    
    msgs = payload.get("messages", [])
    if isinstance(msgs, list):
        new_msgs = []
        for m in msgs:
            if isinstance(m, dict):
                m_copy = dict(m)
                if m_copy.get("role") == "developer":
                    m_copy["role"] = "system"
                new_msgs.append(m_copy)
            else:
                new_msgs.append(m)
        payload["messages"] = new_msgs

    if payload.get("reasoning_effort") == "off":
        del payload["reasoning_effort"]

    tc = payload.get("tool_choice")
    if isinstance(tc, str) and tc.lower() == "none":
        payload.pop("tools", None)
        payload.pop("functions", None)
        payload.pop("tool_choice", None)
    elif isinstance(tc, dict):
        if tc.get("type") == "function" and isinstance(tc.get("function"), dict):
            payload["tool_choice"] = tc["function"].get("name", "auto")
        elif tc.get("type") in ["auto", "required"]:
            payload["tool_choice"] = tc["type"]

    return payload

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WorkBuddy 桥接与模型监控面板</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922; }
  body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
  .container { max-width: 1100px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
  .title { font-size: 22px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px; }
  .badge-status { background: #238636; color: #fff; font-size: 12px; padding: 3px 8px; border-radius: 12px; font-weight: 500; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h3 { margin: 0 0 12px 0; font-size: 15px; color: #fff; display: flex; align-items: center; justify-content: space-between; }
  .info-item { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 0; border-bottom: 1px solid #21262d; }
  .info-item:last-child { border-bottom: none; }
  .info-label { color: var(--text-muted); }
  .info-value { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #e6edf3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { background: #21262d; color: #8b949e; font-weight: 600; }
  tr:hover { background: #1c2128; }
  .badge-free { background: rgba(56, 139, 253, 0.15); color: #58a6ff; border: 1px solid rgba(56, 139, 253, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .badge-promo { background: rgba(248, 81, 73, 0.15); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 4px; }
  .badge-effort { background: rgba(63, 185, 80, 0.15); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
  .btn { background: #238636; color: #fff; border: 1px solid rgba(240, 246, 252, 0.1); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; transition: 0.2s; }
  .btn:hover { background: #2ea043; }
  .btn-secondary { background: #21262d; border-color: var(--border); color: #c9d1d9; }
  .btn-secondary:hover { background: #30363d; }
  .code-block { background: #090d13; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 12px; font-family: monospace; color: #79c0ff; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="title">
      <span>⚡ WorkBuddy to Codeg 本地桥接服务</span>
      <span class="badge-status">运行中</span>
    </div>
    <div style="font-size: 13px; color: var(--text-muted)">
      API 接口: <code class="code-block" style="padding: 2px 6px;">http://127.0.0.1:__PORT__/v1</code>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h3><span>👤 账号凭据状态</span></h3>
      <div class="info-item"><span class="info-label">用户标识 (UID)</span><span class="info-value">__UID__</span></div>
      <div class="info-item"><span class="info-label">平台域名</span><span class="info-value">__DOMAIN__</span></div>
      <div class="info-item"><span class="info-label">Token 有效期</span><span class="info-value">__EXPIRES__</span></div>
      <div class="info-item"><span class="info-label">凭据解密模式</span><span class="info-value" style="color: var(--green);">AES-256-GCM (自动解密)</span></div>
    </div>
    <div class="card">
      <h3><span>⚙️ Codeg 配置说明</span></h3>
      <div style="font-size: 13px; line-height: 1.6; color: var(--text-muted);">
        1. 打开 Codeg <b>设置 ⚙️ -> 模型供应商</b><br>
        2. 点击 <b>添加供应商</b>，类型选择 <b>全部</b> 或指定 Agent<br>
        3. API 地址填：<b style="color: #fff;">http://127.0.0.1:__PORT__/v1</b><br>
        4. 密钥填：<b style="color: #fff;">none</b>，即可在聊天输入框直接使用！
      </div>
    </div>
  </div>

  <div class="card">
    <h3>
      <span>📋 可用模型清单与倍率 (共 __TOTAL_MODELS__ 个)</span>
      <div>
        <button class="btn btn-secondary" onclick="location.reload()">🔄 刷新列表</button>
      </div>
    </h3>
    <table>
      <thead>
        <tr>
          <th>模型 ID</th>
          <th>显示名称</th>
          <th>扣费倍率 / 折扣</th>
          <th>上下文窗口</th>
          <th>推理档位探测 (Probe)</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        __TABLE_ROWS__
      </tbody>
    </table>
  </div>
</div>

<script>
async function runProbe(modelId, btn) {
  btn.innerText = '探测中...';
  btn.disabled = true;
  try {
    const res = await fetch('/v1/probe?model=' + encodeURIComponent(modelId), { method: 'POST' });
    const data = await res.json();
    alert('【' + modelId + ' 探测结果】\\n' + (data.description || data.validating));
    location.reload();
  } catch (e) {
    alert('探测失败: ' + e);
    btn.innerText = '探测';
    btn.disabled = false;
  }
}
</script>
</body>
</html>
"""

class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/" or path == "/health":
            self._handle_dashboard()
        elif path in ["/v1/models", "/models"]:
            self._handle_models()
        elif path == "/v1/probe":
            self._handle_probe_get(parsed)
        else:
            self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ["/v1/chat/completions", "/chat/completions"]:
            self._handle_chat()
        elif path == "/v1/probe":
            self._handle_probe_post(parsed)
        else:
            self.send_error(404, "Not Found")

    def _handle_dashboard(self):
        try:
            token, account = auth_manager.get_credentials()
            models = model_service.fetch_models_with_billing()
            
            exp_sec = account.get("expiresAt", 0)
            exp_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp_sec / 1000)) if exp_sec > 0 else "有效"

            rows = []
            for m in models:
                mid = m["id"]
                badges_html = []
                if m.get("credits"):
                    badges_html.append(f"<span class='badge-free'>{m['credits']}</span>")
                for b in m.get("badges", []):
                    badges_html.append(f"<span class='badge-promo'>{b}</span>")
                if not badges_html:
                    badges_html.append("<span style='color: var(--text-muted);'>标准计费</span>")

                probe_info = m.get("probed")
                if probe_info:
                    efforts = probe_info.get("supported_efforts", [])
                    if efforts:
                        effort_html = "".join([f"<span class='badge-effort'>{e}</span>" for e in efforts])
                    elif probe_info.get("validating") == "non-validating":
                        effort_html = "<span style='color: var(--text-muted); font-size: 11px;'>不校验档位</span>"
                    else:
                        effort_html = "<span style='color: var(--yellow); font-size: 11px;'>未知</span>"
                else:
                    effort_html = "<span style='color: var(--text-muted); font-size: 11px;'>未探测</span>"

                in_tok = m.get("maxInputTokens") or "-"
                out_tok = m.get("maxOutputTokens") or "-"
                ctx_str = f"{in_tok} in / {out_tok} out"

                row = f"""
                <tr>
                  <td><code style='color: #79c0ff;'>{mid}</code></td>
                  <td>{m['raw_name']}</td>
                  <td>{' '.join(badges_html)}</td>
                  <td style='color: var(--text-muted); font-size: 12px;'>{ctx_str}</td>
                  <td>{effort_html}</td>
                  <td><button class='btn btn-secondary' onclick='runProbe("{mid}", this)'>⚡ 探测</button></td>
                </tr>
                """
                rows.append(row)

            html = DASHBOARD_HTML
            html = html.replace("__PORT__", str(PORT))
            html = html.replace("__UID__", str(account.get("uid") or "匿名用户"))
            html = html.replace("__DOMAIN__", str(account.get("domain") or "www.workbuddy.cn"))
            html = html.replace("__EXPIRES__", exp_str)
            html = html.replace("__TOTAL_MODELS__", str(len(models)))
            html = html.replace("__TABLE_ROWS__", "\n".join(rows))

            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = f"<h1>加载仪表盘失败</h1><p>{e}</p>".encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(err)

    def _handle_models(self):
        try:
            models = model_service.fetch_models_with_billing()
            openai_models = []
            for m in models:
                openai_models.append({
                    "id": m["id"],
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "workbuddy",
                    "permission": [],
                    "root": m["id"],
                    "name": m["name"],
                    "credits": m.get("credits"),
                    "badges": m.get("badges"),
                    "free": m.get("free")
                })

            resp_payload = {
                "object": "list",
                "data": openai_models
            }
            body = json.dumps(resp_payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            logger.error(f"Failed to fetch models: {e}")
            self.send_error(500, str(e))

    def _handle_probe_get(self, parsed):
        qs = parse_qs(parsed.query)
        model_id = qs.get("model", [""])[0]
        if not model_id:
            self.send_error(400, "Missing model query parameter")
            return
        result = model_service.probe_model_effort(model_id)
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_probe_post(self, parsed):
        qs = parse_qs(parsed.query)
        model_id = qs.get("model", [""])[0]
        if not model_id:
            content_len = int(self.headers.get("Content-Length", 0))
            if content_len > 0:
                try:
                    data = json.loads(self.rfile.read(content_len).decode("utf-8"))
                    model_id = data.get("model", "")
                except Exception:
                    pass
        if not model_id:
            self.send_error(400, "Missing model parameter")
            return

        result = model_service.probe_model_effort(model_id)
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_chat(self):
        content_len = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_len).decode("utf-8")
        try:
            req_data = json.loads(raw_body)
        except Exception:
            self.send_error(400, "Invalid JSON")
            return

        is_client_stream = req_data.get("stream", False)
        target_model = req_data.get("model", "deepseek-v4-flash")
        logger.info(f"Chat request -> Model: {target_model}, Stream: {is_client_stream}")

        try:
            token, account = auth_manager.get_credentials()
            upstream_headers = build_upstream_headers(token, account)
            normalized_body = normalize_chat_body(req_data)
            body_bytes = json.dumps(normalized_body).encode("utf-8")

            upstream_req = urllib.request.Request(
                "https://copilot.tencent.com/v2/chat/completions",
                data=body_bytes,
                headers=upstream_headers
            )

            upstream_resp = urllib.request.urlopen(upstream_req, timeout=120)
            
            if is_client_stream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()

                while True:
                    line = upstream_resp.readline()
                    if not line:
                        break
                    self.wfile.write(line)
                    self.wfile.flush()
            else:
                full_content = []
                full_reasoning = []
                finish_reason = "stop"
                last_id = f"chatcmpl-{uuid.uuid4()}"

                while True:
                    line = upstream_resp.readline()
                    if not line:
                        break
                    line_str = line.decode("utf-8", errors="ignore").strip()
                    if line_str.startswith("data: ") and line_str != "data: [DONE]":
                        try:
                            chunk = json.loads(line_str[6:])
                            if "id" in chunk:
                                last_id = chunk["id"]
                            choices = chunk.get("choices", [])
                            if choices:
                                delta = choices[0].get("delta", {})
                                if delta.get("content"):
                                    full_content.append(delta["content"])
                                if delta.get("reasoning_content"):
                                    full_reasoning.append(delta["reasoning_content"])
                                if choices[0].get("finish_reason"):
                                    finish_reason = choices[0]["finish_reason"]
                        except Exception:
                            pass

                aggregated_response = {
                    "id": last_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": target_model,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "".join(full_content)
                        },
                        "finish_reason": finish_reason
                    }],
                    "usage": {
                        "prompt_tokens": 0,
                        "completion_tokens": len("".join(full_content)),
                        "total_tokens": len("".join(full_content))
                    }
                }
                body_out = json.dumps(aggregated_response, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body_out)))
                self.end_headers()
                self.wfile.write(body_out)

        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="ignore")
            logger.error(f"WorkBuddy upstream returned HTTP {e.code}: {err_msg}")
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": {
                    "message": f"WorkBuddy Upstream Error {e.code}: {err_msg}",
                    "type": "upstream_error",
                    "code": e.code
                }
            }).encode("utf-8"))
        except Exception as e:
            logger.error(f"Exception handling chat completion: {e}")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": {
                    "message": str(e),
                    "type": "bridge_error"
                }
            }).encode("utf-8"))

def main():
    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    logger.info("=" * 60)
    logger.info(f"WorkBuddy Codeg Bridge is running!")
    logger.info(f"Dashboard: http://{HOST}:{PORT}/")
    logger.info(f"Models:    http://{HOST}:{PORT}/v1/models")
    logger.info(f"Chat:      http://{HOST}:{PORT}/v1/chat/completions")
    logger.info(f"Probe:     http://{HOST}:{PORT}/v1/probe?model=<id>")
    logger.info("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Server stopped.")

if __name__ == "__main__":
    main()
