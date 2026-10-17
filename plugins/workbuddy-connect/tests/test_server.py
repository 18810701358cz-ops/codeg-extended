# -*- coding: utf-8 -*-
import os
import sys
import json
import time
import socket
import unittest
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch, MagicMock

# Ensure plugin directory is on sys.path
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TEST_DIR)
if PLUGIN_ROOT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT)

from backend import server


class BaseServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Configure test environment
        cls.test_token = "secret-test-token-12345"
        os.environ["CODEG_PLUGIN_TOKEN"] = cls.test_token
        os.environ["HOST"] = "127.0.0.1"
        os.environ["WORKBUDDY_PROBE_CONSENT"] = "false"

        # Mock auth_manager credentials to avoid loading real local files or executing helper
        cls._orig_get_credentials = server.auth_manager.get_credentials
        server.auth_manager.get_credentials = lambda: (
            "mock-upstream-access-token",
            {
                "uid": "mock-test-uid",
                "enterpriseId": "mock-enterprise-id",
                "domain": "copilot.tencent.com",
                "nickname": "Test Tester",
                "uin": "100001",
                "expiresAt": 1893456000000,
            },
        )

        # Mock model_service fetch and probe to ensure offline execution
        cls._orig_fetch_models = server.model_service.fetch_models_with_billing
        cls._orig_probe_model = server.model_service.probe_model_effort

        server.model_service.fetch_models_with_billing = lambda: [
            {
                "id": "mock-deepseek-v4",
                "name": "Mock DeepSeek v4 [x0.00 免]",
                "raw_name": "Mock DeepSeek v4",
                "credits": "x0.00",
                "badges": ["限时免费"],
                "free": True,
                "maxInputTokens": 128000,
                "maxOutputTokens": 4096,
                "supportsImages": False,
                "probed": {"validating": "validating", "supported_efforts": ["low", "high"]},
            }
        ]

        server.model_service.probe_model_effort = lambda model_id: {
            "model": model_id,
            "validating": "validating",
            "supported_efforts": ["low", "medium", "high"],
            "description": f"Mocked probe result for {model_id}",
            "timestamp": 1700000000,
        }

        # Start live HTTP server on port 0 (assigned by OS)
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.BridgeHandler)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        except Exception:
            pass
        server.auth_manager.get_credentials = cls._orig_get_credentials
        server.model_service.fetch_models_with_billing = cls._orig_fetch_models
        server.model_service.probe_model_effort = cls._orig_probe_model

    def request(self, path, method="GET", headers=None, body=None):
        url = f"{self.base_url}{path}"
        req_headers = dict(headers or {})
        data_bytes = None
        if body is not None:
            if isinstance(body, dict):
                data_bytes = json.dumps(body).encode("utf-8")
                if "Content-Type" not in req_headers:
                    req_headers["Content-Type"] = "application/json"
            elif isinstance(body, (bytes, bytearray)):
                data_bytes = body
            elif isinstance(body, str):
                data_bytes = body.encode("utf-8")

        req = Request(url, data=data_bytes, headers=req_headers, method=method)
        try:
            with urlopen(req, timeout=5) as resp:
                resp_body = resp.read().decode("utf-8")
                return resp.status, resp.headers, resp_body
        except HTTPError as e:
            err_body = e.read().decode("utf-8")
            return e.code, e.headers, err_body

    def assert_no_cors_headers(self, headers):
        for header_key in headers.keys():
            self.assertFalse(
                header_key.lower().startswith("access-control-"),
                f"Unexpected CORS header found: {header_key}: {headers[header_key]}",
            )


class TestHealthCheckEndpoints(BaseServerTest):
    def test_healthz_unauthenticated(self):
        status, headers, body = self.request("/healthz")
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertEqual(data, {"ok": True})

    def test_health_alias_unauthenticated(self):
        status, headers, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertEqual(data, {"ok": True})

    def test_healthz_head_method(self):
        status, headers, _ = self.request("/healthz", method="HEAD")
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))

    def test_health_head_method(self):
        status, headers, _ = self.request("/health", method="HEAD")
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))


class TestAuthentication(BaseServerTest):
    def test_models_without_token_returns_401(self):
        status, headers, body = self.request("/v1/models")
        self.assertEqual(status, 401)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertIn("error", data)
        self.assertEqual(data["error"]["code"], 401)

    def test_models_with_invalid_token_returns_401(self):
        status, headers, body = self.request(
            "/v1/models", headers={"Authorization": "Bearer invalid-wrong-token"}
        )
        self.assertEqual(status, 401)
        self.assert_no_cors_headers(headers)
        data = json.loads(body)
        self.assertIn("error", data)

    def test_models_with_non_bearer_header_returns_401(self):
        status, headers, body = self.request(
            "/v1/models", headers={"Authorization": f"Basic {self.test_token}"}
        )
        self.assertEqual(status, 401)
        self.assert_no_cors_headers(headers)

    def test_dashboard_without_token_returns_401(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 401)
        self.assert_no_cors_headers(headers)
        data = json.loads(body)
        self.assertIn("error", data)

    def test_dashboard_with_valid_token_returns_200_html(self):
        status, headers, body = self.request(
            "/", headers={"Authorization": f"Bearer {self.test_token}"}
        )
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        self.assertIn("WorkBuddy to Codeg 本地桥接服务", body)
        self.assertIn("mock-deepseek-v4", body)

    def test_models_with_valid_token_returns_200(self):
        status, headers, body = self.request(
            "/v1/models", headers={"Authorization": f"Bearer {self.test_token}"}
        )
        self.assertEqual(status, 200)
        self.assert_no_cors_headers(headers)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        data = json.loads(body)
        self.assertEqual(data.get("object"), "list")
        self.assertTrue(len(data.get("data", [])) > 0)
        self.assertEqual(data["data"][0]["id"], "mock-deepseek-v4")

    def test_chat_without_token_returns_401(self):
        payload = {
            "model": "mock-deepseek-v4",
            "messages": [{"role": "user", "content": "hi"}],
        }
        status, headers, body = self.request(
            "/v1/chat/completions", method="POST", body=payload
        )
        self.assertEqual(status, 401)
        self.assert_no_cors_headers(headers)

    def test_chat_with_valid_token_mocked(self):
        payload = {
            "model": "mock-deepseek-v4",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": False,
        }
        mock_resp = MagicMock()
        mock_resp.readline.side_effect = [
            b'data: {"id":"chatcmpl-mock-123","choices":[{"delta":{"content":"Hi there!"},"finish_reason":"stop"}]}\n',
            b"data: [DONE]\n",
            b"",
        ]

        with patch("urllib.request.urlopen", return_value=mock_resp):
            status, headers, body = self.request(
                "/v1/chat/completions",
                method="POST",
                headers={"Authorization": f"Bearer {self.test_token}"},
                body=payload,
            )
            self.assertEqual(status, 200)
            self.assert_no_cors_headers(headers)
            data = json.loads(body)
            self.assertEqual(data["object"], "chat.completion")
            self.assertEqual(data["choices"][0]["message"]["content"], "Hi there!")


class TestProbeConsent(BaseServerTest):
    def test_probe_without_consent_returns_403(self):
        old_val = os.environ.get("WORKBUDDY_PROBE_CONSENT")
        try:
            os.environ["WORKBUDDY_PROBE_CONSENT"] = "false"
            status, headers, body = self.request(
                "/v1/probe?model=mock-deepseek-v4",
                method="GET",
                headers={"Authorization": f"Bearer {self.test_token}"},
            )
            self.assertEqual(status, 403)
            self.assert_no_cors_headers(headers)
            data = json.loads(body)
            self.assertIn("error", data)
            self.assertEqual(data["error"]["code"], 403)
            self.assertIn("Probe consent required", data["error"]["message"])

            # Test POST /v1/probe without consent
            status_post, headers_post, body_post = self.request(
                "/v1/probe",
                method="POST",
                headers={"Authorization": f"Bearer {self.test_token}"},
                body={"model": "mock-deepseek-v4"},
            )
            self.assertEqual(status_post, 403)
            self.assert_no_cors_headers(headers_post)
        finally:
            if old_val is not None:
                os.environ["WORKBUDDY_PROBE_CONSENT"] = old_val
            else:
                os.environ.pop("WORKBUDDY_PROBE_CONSENT", None)

    def test_probe_with_consent_returns_200(self):
        old_val = os.environ.get("WORKBUDDY_PROBE_CONSENT")
        try:
            os.environ["WORKBUDDY_PROBE_CONSENT"] = "true"
            status, headers, body = self.request(
                "/v1/probe?model=mock-deepseek-v4",
                method="GET",
                headers={"Authorization": f"Bearer {self.test_token}"},
            )
            self.assertEqual(status, 200)
            self.assert_no_cors_headers(headers)
            data = json.loads(body)
            self.assertEqual(data.get("validating"), "validating")
            self.assertIn("low", data.get("supported_efforts", []))

            # Test POST /v1/probe with consent
            status_post, headers_post, body_post = self.request(
                "/v1/probe",
                method="POST",
                headers={"Authorization": f"Bearer {self.test_token}"},
                body={"model": "mock-deepseek-v4"},
            )
            self.assertEqual(status_post, 200)
            self.assert_no_cors_headers(headers_post)
            data_post = json.loads(body_post)
            self.assertEqual(data_post.get("model"), "mock-deepseek-v4")
        finally:
            if old_val is not None:
                os.environ["WORKBUDDY_PROBE_CONSENT"] = old_val
            else:
                os.environ.pop("WORKBUDDY_PROBE_CONSENT", None)


class TestStartupAndPortConflict(unittest.TestCase):
    def test_startup_validation_missing_token_aborts(self):
        old_token = os.environ.get("CODEG_PLUGIN_TOKEN")
        old_allow = os.environ.get("WORKBUDDY_ALLOW_NO_TOKEN")
        try:
            os.environ.pop("CODEG_PLUGIN_TOKEN", None)
            os.environ.pop("WORKBUDDY_ALLOW_NO_TOKEN", None)
            with self.assertRaises(SystemExit) as cm:
                server.validate_startup_config("127.0.0.1", 18080)
            self.assertEqual(cm.exception.code, 1)

            # But with WORKBUDDY_ALLOW_NO_TOKEN=1 it should pass
            os.environ["WORKBUDDY_ALLOW_NO_TOKEN"] = "1"
            server.validate_startup_config("127.0.0.1", 18080)
        finally:
            if old_token is not None:
                os.environ["CODEG_PLUGIN_TOKEN"] = old_token
            else:
                os.environ.pop("CODEG_PLUGIN_TOKEN", None)
            if old_allow is not None:
                os.environ["WORKBUDDY_ALLOW_NO_TOKEN"] = old_allow
            else:
                os.environ.pop("WORKBUDDY_ALLOW_NO_TOKEN", None)

    def test_startup_validation_remote_host_without_permission_aborts(self):
        old_token = os.environ.get("CODEG_PLUGIN_TOKEN")
        old_remote = os.environ.get("WORKBUDDY_ALLOW_REMOTE")
        try:
            os.environ["CODEG_PLUGIN_TOKEN"] = "any-token"
            os.environ.pop("WORKBUDDY_ALLOW_REMOTE", None)
            with self.assertRaises(SystemExit) as cm:
                server.validate_startup_config("0.0.0.0", 18080)
            self.assertEqual(cm.exception.code, 1)

            # With WORKBUDDY_ALLOW_REMOTE=1 it should pass
            os.environ["WORKBUDDY_ALLOW_REMOTE"] = "1"
            server.validate_startup_config("0.0.0.0", 18080)
        finally:
            if old_token is not None:
                os.environ["CODEG_PLUGIN_TOKEN"] = old_token
            else:
                os.environ.pop("CODEG_PLUGIN_TOKEN", None)
            if old_remote is not None:
                os.environ["WORKBUDDY_ALLOW_REMOTE"] = old_remote
            else:
                os.environ.pop("WORKBUDDY_ALLOW_REMOTE", None)

    def test_port_conflict_exits_with_code_3(self):
        old_token = os.environ.get("CODEG_PLUGIN_TOKEN")
        try:
            os.environ["CODEG_PLUGIN_TOKEN"] = "test-token"
            # Occupy a local port with a socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            occupied_port = sock.getsockname()[1]

            # Attempting to create server on the occupied port must exit with code 3
            with self.assertRaises(SystemExit) as cm:
                server.create_server("127.0.0.1", occupied_port)
            self.assertEqual(cm.exception.code, 3)

            sock.close()
        finally:
            if old_token is not None:
                os.environ["CODEG_PLUGIN_TOKEN"] = old_token
            else:
                os.environ.pop("CODEG_PLUGIN_TOKEN", None)


class TestAuthFileOverride(unittest.TestCase):
    def test_workbuddy_auth_file_env_override(self):
        old_env = os.environ.get("WORKBUDDY_AUTH_FILE")
        try:
            custom_path = r"C:\fake\custom\workbuddy-desktop.info"
            os.environ["WORKBUDDY_AUTH_FILE"] = custom_path
            auth = server.WorkBuddyAuth()
            self.assertEqual(auth.effective_auth_path, custom_path)
        finally:
            if old_env is not None:
                os.environ["WORKBUDDY_AUTH_FILE"] = old_env
            else:
                os.environ.pop("WORKBUDDY_AUTH_FILE", None)


if __name__ == "__main__":
    unittest.main()
