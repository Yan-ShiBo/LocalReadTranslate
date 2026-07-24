import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import addon_host


def test_proxy_timeout_allows_cold_translation_models_to_initialize():
    assert addon_host.UPSTREAM_TIMEOUT_SECONDS >= 120


class _UpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return None

    def do_GET(self):
        if self.path == "/document/latex/health":
            payload = json.dumps(
                {"available": True, "version": "3.8"}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        payload = json.loads(self.rfile.read(length))
        if self.path == "/tts":
            if self.headers.get("Accept") != "audio/wav":
                self.send_error(406)
                return
            result = b"RIFF-test-audio"
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
            return
        if self.path == "/document/pdf-selection-to-latex":
            result = json.dumps(
                {
                    "latex": "$x_{t+1}$",
                    "formula_count": 1,
                    "inline_formula_count": 1,
                    "display_formula_count": 0,
                    "warnings": [],
                    "model": payload["model"],
                    "recognizer": "ollama-pdf-selection",
                    "elapsed": 0.1,
                    "received_text": payload["text"],
                    "received_html": payload["html"],
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
            return
        result = json.dumps(
            {"canonical_latex": payload["text"], "formula_count": 1}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result)))
        self.end_headers()
        self.wfile.write(result)


@pytest.fixture()
def upstream_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _UpstreamHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.fixture()
def addin_server(upstream_server):
    upstream_port = upstream_server.server_address[1]
    control_actions = []
    server = addon_host.create_server(
        port=0,
        api_base_url=f"http://127.0.0.1:{upstream_port}",
        control_dispatcher=control_actions.append,
    )
    server.test_control_actions = control_actions
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(server, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection(
        "127.0.0.1",
        server.server_address[1],
        timeout=3,
    )
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    payload = response.read()
    result = response.status, dict(response.headers), payload
    connection.close()
    return result


@pytest.mark.parametrize(
    "value",
    [
        "https://127.0.0.1:5000",
        "http://10.0.0.1:5000",
        "http://127.0.0.1:5000/private",
        "http://127.0.0.1",
    ],
)
def test_api_upstream_is_restricted_to_plain_http_loopback(value):
    with pytest.raises(ValueError):
        addon_host.normalized_api_base_url(value)


def test_health_and_static_assets_are_explicitly_served(addin_server):
    status, headers, payload = request(addin_server, "GET", "/health")
    assert status == 200
    assert json.loads(payload)["service"] == "localreadtranslate-addin-host"
    assert headers["Cache-Control"] == "no-store"
    assert "default-src 'self'" in headers["Content-Security-Policy"]
    assert "media-src 'self' blob:" in headers["Content-Security-Policy"]

    status, headers, payload = request(
        addin_server,
        "GET",
        "/taskpane/taskpane.html",
    )
    assert status == 200
    assert "text/html" in headers["Content-Type"]
    assert b"convert-button" in payload
    assert b"read-button" in payload
    assert b"translate-button" in payload

    status, headers, payload = request(
        addin_server,
        "GET",
        "/wps-pdf/manifest.xml",
    )
    assert status == 200
    assert "xml" in headers["Content-Type"]
    assert b"LocalReadTranslatePdf" in payload

    status, headers, payload = request(
        addin_server,
        "GET",
        "/wps-pdf/pdf-adapter.js",
    )
    assert status == 200
    assert "javascript" in headers["Content-Type"]
    assert b"createWpsPdfAdapter" in payload

    status, _headers, payload = request(
        addin_server,
        "GET",
        "/assets/icon-32.png",
    )
    assert status == 200
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")


def test_unknown_and_traversal_assets_are_not_exposed(addin_server):
    assert request(addin_server, "GET", "/server.py")[0] == 404
    assert request(addin_server, "GET", "/taskpane/../../server.py")[0] == 404
    assert request(addin_server, "GET", "/.git/config")[0] == 404


def test_get_and_json_post_are_proxied_under_api_only(addin_server):
    status, _headers, payload = request(
        addin_server,
        "GET",
        "/api/document/latex/health",
    )
    assert status == 200
    assert json.loads(payload) == {"available": True, "version": "3.8"}

    body = json.dumps({"text": "$x^2$"}).encode("utf-8")
    status, _headers, payload = request(
        addin_server,
        "POST",
        "/api/document/latex-fragment",
        body=body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )
    assert status == 200
    assert json.loads(payload)["canonical_latex"] == "$x^2$"

    assert request(
        addin_server,
        "POST",
        "/taskpane/taskpane.html",
        body=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "2"},
    )[0] == 405


def test_control_actions_use_a_fixed_allowlist_and_require_the_addin_header(
    addin_server,
):
    status, _headers, payload = request(
        addin_server,
        "POST",
        "/api/control/remote",
        headers={
            addon_host.CONTROL_ACTION_HEADER: "1",
            "Content-Length": "0",
        },
    )
    assert status == 202
    assert json.loads(payload) == {"status": "requested", "action": "remote"}
    assert addin_server.test_control_actions == ["remote"]

    assert request(
        addin_server,
        "POST",
        "/api/control/ollama",
        headers={"Content-Length": "0"},
    )[0] == 403
    assert request(
        addin_server,
        "POST",
        "/api/control/shutdown",
        headers={
            addon_host.CONTROL_ACTION_HEADER: "1",
            "Content-Length": "0",
        },
    )[0] == 404
    assert request(
        addin_server,
        "POST",
        "/api/control/start?command=anything",
        headers={
            addon_host.CONTROL_ACTION_HEADER: "1",
            "Content-Length": "0",
        },
    )[0] == 404
    assert request(
        addin_server,
        "POST",
        "/api/control/start",
        body=b"{}",
        headers={
            addon_host.CONTROL_ACTION_HEADER: "1",
            "Content-Length": "2",
        },
    )[0] == 400
    assert addin_server.test_control_actions == ["remote"]


def test_wps_pdf_formula_request_proxies_selected_text_without_clipboard_access(
    addin_server,
):
    body = json.dumps(
        {
            "text": "x\r\n2\r\n1",
            "html": "",
            "model": "remote:project-server:qwen3:30b",
        }
    ).encode("utf-8")
    status, _headers, payload = request(
        addin_server,
        "POST",
        "/api/document/pdf-selection-to-latex",
        body=body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )

    assert status == 200
    result = json.loads(payload)
    assert result["latex"] == "$x_{t+1}$"
    assert result["model"] == "remote:project-server:qwen3:30b"
    assert result["received_text"] == "x\r\n2\r\n1"
    assert result["received_html"] == ""

    assert request(
        addin_server,
        "POST",
        "/api/addin/pdf-selection-to-latex",
        body=body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )[0] == 404


def test_console_log_text_is_safe_for_legacy_windows_encodings():
    assert addon_host._console_safe_text("bad \N{GRINNING FACE}", "ascii") == (
        r"bad \U0001f600"
    )


def test_proxy_rejects_non_json_and_oversize_lengths(addin_server):
    assert request(
        addin_server,
        "POST",
        "/api/document/latex-fragment",
        body=b"text",
        headers={"Content-Type": "text/plain", "Content-Length": "4"},
    )[0] == 415

    assert request(
        addin_server,
        "POST",
        "/api/document/latex-fragment",
        body=b"",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(addon_host.MAX_REQUEST_BYTES + 1),
        },
    )[0] == 413


def test_proxy_forwards_audio_accept_and_response_type(addin_server):
    body = json.dumps(
        {"text": "Readable English.", "voice": "af_bella", "speed": 0.8}
    ).encode("utf-8")
    status, headers, payload = request(
        addin_server,
        "POST",
        "/api/tts",
        body=body,
        headers={
            "Accept": "audio/wav",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )

    assert status == 200
    assert headers["Content-Type"] == "audio/wav"
    assert payload == b"RIFF-test-audio"
