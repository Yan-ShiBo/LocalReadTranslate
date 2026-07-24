"""Loopback web host for the LocalReadTranslate Word/WPS add-ins.

The existing FastAPI service intentionally remains on plain HTTP loopback.
This process serves a small, explicit set of add-in assets and proxies only
``/api/*`` requests to the local FastAPI service.  It binds to 127.0.0.1 and
does not expose the repository or API to the LAN.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import ssl
import sys
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_DIR = Path(__file__).resolve().parent
ADDONS_DIR = PROJECT_DIR / "addons"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5443
DEFAULT_API_BASE_URL = "http://127.0.0.1:5000"
MAX_REQUEST_BYTES = 12 * 1024 * 1024
# Cold initialization of a discovered Ollama model can legitimately exceed one
# minute. Match the userscript's long-running translation allowance while
# keeping the add-in proxy bounded.
UPSTREAM_TIMEOUT_SECONDS = 150
CONTROL_ACTION_HEADER = "X-LocalReadTranslate-Addin"
CONTROL_ACTIONS = {
    "start": "localreadtranslate://start",
    "ollama": "localreadtranslate://ollama",
    "remote": "localreadtranslate://remote",
}

# A tiny valid PNG is embedded so the Office manifest does not depend on a
# generated binary file in the repository.  The task pane itself uses text and
# CSS, so this icon is only manifest/ribbon metadata.
_ICON_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAARUlEQVR4nO3N"
    "MQEAAAjDMMC/52ECvQqsYJDt7MczgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAg"
    "EAgEAoFAIBAIBAKBQCAQCAQCPwAfMgJAXqQwUQAAAABJRU5ErkJggg=="
)

STATIC_ROUTES = {
    "/taskpane/taskpane.html": ADDONS_DIR / "taskpane" / "taskpane.html",
    "/taskpane/taskpane.css": ADDONS_DIR / "taskpane" / "taskpane.css",
    "/taskpane/taskpane.js": ADDONS_DIR / "taskpane" / "taskpane.js",
    "/shared/localreadtranslate-client.js": (
        ADDONS_DIR / "shared" / "localreadtranslate-client.js"
    ),
    "/shared/formula-controller.js": ADDONS_DIR / "shared" / "formula-controller.js",
    "/office-word/office-adapter.js": ADDONS_DIR / "office-word" / "office-adapter.js",
    "/office-word/manifest.xml": ADDONS_DIR / "office-word" / "manifest.xml",
    "/wps-word/index.html": ADDONS_DIR / "wps-word" / "index.html",
    "/wps-word/manifest.xml": ADDONS_DIR / "wps-word" / "manifest.xml",
    "/wps-word/main.js": ADDONS_DIR / "wps-word" / "main.js",
    "/wps-word/ribbon.xml": ADDONS_DIR / "wps-word" / "ribbon.xml",
    "/wps-word/js/ribbon.js": ADDONS_DIR / "wps-word" / "js" / "ribbon.js",
    "/wps-word/wps-adapter.js": ADDONS_DIR / "wps-word" / "wps-adapter.js",
    "/wps-pdf/index.html": ADDONS_DIR / "wps-pdf" / "index.html",
    "/wps-pdf/manifest.xml": ADDONS_DIR / "wps-pdf" / "manifest.xml",
    "/wps-pdf/main.js": ADDONS_DIR / "wps-pdf" / "main.js",
    "/wps-pdf/ribbon.xml": ADDONS_DIR / "wps-pdf" / "ribbon.xml",
    "/wps-pdf/js/ribbon.js": ADDONS_DIR / "wps-pdf" / "js" / "ribbon.js",
    "/wps-pdf/pdf-adapter.js": ADDONS_DIR / "wps-pdf" / "pdf-adapter.js",
}


def normalized_api_base_url(value: str) -> str:
    """Accept only an HTTP loopback upstream with no path component."""
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise ValueError("The add-in API upstream must be an HTTP loopback URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("The add-in API upstream must not include a path")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("The add-in API upstream port is invalid") from error
    if port is None or not 1 <= port <= 65535:
        raise ValueError("The add-in API upstream requires a valid port")
    return f"http://127.0.0.1:{port}"


def dispatch_control_action(action: str) -> None:
    """Open one fixed tray-owned action through the registered URL handler."""
    protocol_url = CONTROL_ACTIONS.get(str(action or ""))
    if protocol_url is None:
        raise ValueError("Unsupported add-in control action")
    try:
        startfile = os.startfile
    except AttributeError as error:
        raise OSError("Add-in control actions require Windows") from error
    startfile(protocol_url)


def _console_safe_text(value: str, encoding: str | None) -> str:
    """Make malformed-request diagnostics printable on legacy Windows consoles."""
    selected_encoding = encoding or "utf-8"
    return str(value).encode(
        selected_encoding,
        errors="backslashreplace",
    ).decode(selected_encoding)


class AddinHostServer(ThreadingHTTPServer):
    """Threaded loopback server with immutable routing configuration."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        server_address,
        handler_class,
        *,
        api_base_url: str,
        control_dispatcher=None,
    ):
        super().__init__(server_address, handler_class)
        self.api_base_url = normalized_api_base_url(api_base_url)
        self.control_dispatcher = control_dispatcher or dispatch_control_action


class AddinHostHandler(BaseHTTPRequestHandler):
    """Serve explicit add-in assets and a narrow loopback API proxy."""

    server_version = "LocalReadTranslateAddinHost/1.0"

    def log_message(self, format_string, *args):  # noqa: A003 - stdlib signature
        message = (
            f"[ADDIN {self.log_date_time_string()}] "
            f"{self.address_string()} {format_string % args}"
        )
        stream = sys.stderr
        print(
            _console_safe_text(message, getattr(stream, "encoding", None)),
            file=stream,
            flush=True,
        )

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler contract
        path = urlsplit(self.path).path
        if path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "service": "localreadtranslate-addin-host",
                    "ready": True,
                    "api_base_url": self.server.api_base_url,
                },
            )
            return
        if path in {"/assets/icon-32.png", "/assets/icon-80.png"}:
            self._send_bytes(HTTPStatus.OK, _ICON_PNG, "image/png")
            return
        if path.startswith("/api/"):
            self._proxy_request("GET", self.path)
            return
        if path == "/wps-word/" or path == "/wps-word":
            self._serve_static("/wps-word/index.html")
            return
        if path == "/wps-pdf/" or path == "/wps-pdf":
            self._serve_static("/wps-pdf/index.html")
            return
        self._serve_static(path)

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler contract
        parsed_target = urlsplit(self.path)
        path = parsed_target.path
        if path.startswith("/api/addin/"):
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown add-in action")
            return
        if path.startswith("/api/control/"):
            self._dispatch_control_action(parsed_target)
            return
        if not path.startswith("/api/"):
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "POST is API-only")
            return
        self._proxy_request("POST", self.path)

    def do_OPTIONS(self):  # noqa: N802 - BaseHTTPRequestHandler contract
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "CORS is not enabled")

    def _serve_static(self, path: str):
        file_path = STATIC_ROUTES.get(path)
        if file_path is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown add-in asset")
            return
        try:
            content = file_path.read_bytes()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "Add-in asset is unavailable")
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/xml",
        }:
            content_type = f"{content_type}; charset=utf-8"
        self._send_bytes(HTTPStatus.OK, content, content_type)

    def _dispatch_control_action(self, parsed_target):
        action = parsed_target.path.removeprefix("/api/control/")
        if (
            not action
            or "/" in action
            or parsed_target.query
            or parsed_target.fragment
        ):
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown add-in control action")
            return
        if action not in CONTROL_ACTIONS:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown add-in control action")
            return
        if self.headers.get(CONTROL_ACTION_HEADER) != "1":
            self.send_error(HTTPStatus.FORBIDDEN, "Add-in control header is required")
            return
        if self.headers.get("Transfer-Encoding"):
            self.send_error(HTTPStatus.BAD_REQUEST, "Request body is not accepted")
            return
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_length)
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return
        if content_length != 0:
            self.send_error(HTTPStatus.BAD_REQUEST, "Request body is not accepted")
            return
        try:
            self.server.control_dispatcher(action)
        except (OSError, RuntimeError):
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"detail": "Cannot open the local tray control"},
            )
            return
        self._send_json(
            HTTPStatus.ACCEPTED,
            {"status": "requested", "action": action},
        )

    def _read_request_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length", "")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ValueError("Invalid Content-Length") from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise OverflowError("Request body is too large")
        return self.rfile.read(length)

    def _proxy_request(self, method: str, request_target: str):
        parsed_target = urlsplit(request_target)
        upstream_path = parsed_target.path.removeprefix("/api")
        if not upstream_path.startswith("/"):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid API path")
            return
        if parsed_target.query:
            upstream_path = f"{upstream_path}?{parsed_target.query}"

        data = None
        requested_accept = self.headers.get("Accept", "")
        accepted_type = next(
            (
                content_type
                for content_type in ("audio/wav", "audio/ogg", "application/json")
                if content_type in requested_accept
            ),
            "application/json",
        )
        headers = {"Accept": accepted_type}
        if method == "POST":
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if content_type != "application/json":
                self.send_error(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "Only application/json is accepted",
                )
                return
            try:
                data = self._read_request_body()
            except ValueError:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
                return
            except OverflowError:
                self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            f"{self.server.api_base_url}{upstream_path}",
            data=data,
            headers=headers,
            method=method,
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                payload = response.read(MAX_REQUEST_BYTES + 1)
                if len(payload) > MAX_REQUEST_BYTES:
                    self.send_error(HTTPStatus.BAD_GATEWAY, "API response is too large")
                    return
                content_type = response.headers.get(
                    "Content-Type",
                    "application/json; charset=utf-8",
                )
                self._send_bytes(response.status, payload, content_type)
        except urllib.error.HTTPError as error:
            payload = error.read(MAX_REQUEST_BYTES + 1)
            if len(payload) > MAX_REQUEST_BYTES:
                payload = json.dumps(
                    {"detail": "Local service error response is too large"}
                ).encode("utf-8")
            content_type = error.headers.get(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self._send_bytes(error.code, payload, content_type)
        except (OSError, urllib.error.URLError, TimeoutError):
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"detail": "Cannot connect to the local translation service"},
            )

    def _send_json(self, status: int, payload: dict):
        self._send_bytes(
            status,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _send_bytes(self, status: int, payload: bytes, content_type: str):
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://appsforoffice.microsoft.com; "
            "style-src 'self'; img-src 'self' data:; connect-src 'self'; "
            "font-src 'self'; media-src 'self' blob:; "
            "frame-ancestors 'self' https://*.officeapps.live.com",
        )
        self.end_headers()
        self.wfile.write(payload)


def create_server(
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    api_base_url: str = DEFAULT_API_BASE_URL,
    control_dispatcher=None,
) -> AddinHostServer:
    if host != DEFAULT_HOST:
        raise ValueError("The add-in host must bind to 127.0.0.1")
    # Port 0 is accepted for isolated tests; the CLI default remains 5443.
    if not 0 <= int(port) <= 65535:
        raise ValueError("The add-in host port is invalid")
    return AddinHostServer(
        (host, int(port)),
        AddinHostHandler,
        api_base_url=api_base_url,
        control_dispatcher=control_dispatcher,
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--api-base-url", default=DEFAULT_API_BASE_URL)
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if bool(args.cert) != bool(args.key):
        print("--cert and --key must be provided together.", file=sys.stderr)
        return 2

    server = create_server(
        host=args.host,
        port=args.port,
        api_base_url=args.api_base_url,
    )
    scheme = "http"
    if args.cert and args.key:
        cert_file = args.cert.expanduser().resolve()
        key_file = args.key.expanduser().resolve()
        if not cert_file.is_file() or not key_file.is_file():
            print("The requested TLS certificate or key is missing.", file=sys.stderr)
            return 2
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(
        f"LocalReadTranslate add-in host: {scheme}://localhost:{args.port} "
        f"-> {server.api_base_url}",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
