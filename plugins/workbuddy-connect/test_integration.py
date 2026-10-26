# -*- coding: utf-8 -*-
"""
WorkBuddy Connect End-to-End Integration Test Script.

Validates:
1. /healthz returns 200 OK without authentication.
2. /v1/models without token returns 401 Unauthorized.
3. /v1/models with valid Bearer token returns 200 OK and valid model list.
4. Process cleanup: server terminates gracefully on exit.
"""

import os
import sys
import json
import time
import socket
import urllib.request
import urllib.error
import subprocess


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_healthz(url, timeout_sec=15):
    start = time.time()
    while time.time() - start < timeout_sec:
        try:
            req = urllib.request.Request(f"{url}/healthz")
            with urllib.request.urlopen(req, timeout=1) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    if data.get("ok"):
                        return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def run_integration_test():
    print("[integration] Starting WorkBuddy integration test...")
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    port = find_free_port()
    token = "test-e2e-token-xyz123456"

    env = dict(os.environ)
    env["HOST"] = "127.0.0.1"
    env["PORT"] = str(port)
    env["CODEG_PLUGIN_TOKEN"] = token
    env["PYTHONPATH"] = plugin_dir

    server_script = os.path.join(plugin_dir, "backend", "server.py")
    base_url = f"http://127.0.0.1:{port}"

    print(f"[integration] Spawning server process on port {port}...")
    proc = subprocess.Popen(
        [sys.executable, server_script],
        cwd=plugin_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        # 1. Wait for server to become healthy via /healthz
        print(f"[integration] Polling /healthz on {base_url}...")
        healthy = wait_for_healthz(base_url, timeout_sec=15)
        if not healthy:
            if proc.poll() is not None:
                stdout, stderr = proc.communicate(timeout=2)
                raise RuntimeError(
                    f"Server exited prematurely with code {proc.returncode}:\n{stderr}\n{stdout}"
                )
            raise TimeoutError("Server failed to respond to /healthz within 15 seconds")

        print("[integration] [PASS] 1. /healthz accessible without auth (200 OK)")

        # 2. Verify /v1/models without auth returns 401 Unauthorized
        print("[integration] Verifying /v1/models without token (expecting 401)...")
        req_no_auth = urllib.request.Request(f"{base_url}/v1/models")
        try:
            urllib.request.urlopen(req_no_auth, timeout=5)
            raise AssertionError(
                "Expected 401 Unauthorized when accessing /v1/models without token, but got 200!"
            )
        except urllib.error.HTTPError as e:
            if e.code == 401:
                print(
                    "[integration] [PASS] 2. /v1/models rejected without token (401 Unauthorized)"
                )
            else:
                raise AssertionError(f"Expected 401 Unauthorized, but got HTTP {e.code}")

        # 3. Verify /v1/models with correct Bearer token returns 200 and valid models
        print("[integration] Verifying /v1/models with valid Bearer token (expecting 200)...")
        req_auth = urllib.request.Request(
            f"{base_url}/v1/models",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req_auth, timeout=10) as resp:
            if resp.status != 200:
                raise AssertionError(f"Expected 200 OK, got HTTP {resp.status}")
            payload = json.loads(resp.read().decode("utf-8"))
            if payload.get("object") != "list":
                raise AssertionError(
                    f"Expected 'object': 'list', got {payload.get('object')}"
                )
            models = payload.get("data", [])
            if not isinstance(models, list):
                raise AssertionError("Expected 'data' to be a list")
            print(
                f"[integration] [PASS] 3. /v1/models with Bearer token returned 200 OK and {len(models)} models"
            )

        print("[integration] All integration checks passed!")

    finally:
        print("[integration] Terminating server process...")
        proc.terminate()
        try:
            proc.wait(timeout=5)
            print("[integration] [PASS] 4. Process cleaned up and exited normally")
        except subprocess.TimeoutExpired:
            print("[integration] Force killing server process...")
            proc.kill()
            proc.wait()
            print("[integration] Process killed")


if __name__ == "__main__":
    try:
        run_integration_test()
        sys.exit(0)
    except Exception as e:
        print(f"[integration] FAILED: {e}", file=sys.stderr)
        sys.exit(1)
