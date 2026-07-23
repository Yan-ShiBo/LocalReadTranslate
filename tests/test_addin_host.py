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
    server = addon_host.create_server(
        port=0,
        api_base_url=f"http://127.0.0.1:{upstream_port}",
    )
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
