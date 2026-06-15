# Kokoro TTS Third Iteration Design

Date: 2026-06-16

## Objective

The third iteration adds five high-value improvements:

1. A true continuous `/tts/stream` endpoint using WebM/Opus.
2. OGG/Opus output negotiation for the existing `/tts` endpoint.
3. A horizontal playback and buffering progress control in the userscript.
4. A per-user Windows login auto-start option for the tray application.
5. Automated boundary, concurrency, encoding, streaming, and cleanup tests.

The implementation must preserve the existing WAV API, voice catalog, CUDA
inference path, single-request concurrency policy, tray ownership rules, and
userscript fallback behavior.

## Confirmed Decisions

- Streaming uses strict `MediaSource` playback with a continuous WebM/Opus byte
  stream.
- FFmpeg is supplied by the `imageio-ffmpeg` Python package. A system FFmpeg
  installation is not required.
- Each streaming request owns one FFmpeg child process.
- Browsers without `MediaSource` WebM/Opus support automatically fall back to
  a complete OGG/Opus response.
- The progress UI uses the horizontal fill-button design.
- Before stream completion, the control shows an animated buffering fill and
  elapsed playback seconds. Once duration is known, it switches to an accurate
  percentage.
- Login auto-start launches the tray application through `Kokoro TTS.pyw`.
- Target runtime hardware includes an NVIDIA GeForce RTX 4070 Ti SUPER. CUDA is
  used for Kokoro inference; Opus encoding remains a CPU task.

## Scope

### In Scope

- WebM/Opus streaming over HTTP.
- OGG/Opus complete responses.
- MediaSource userscript playback and OGG fallback.
- Test-page streaming toggle.
- Tray-managed current-user login auto-start.
- Real FFmpeg encoding tests in Windows CI.
- CUDA smoke tests on the local workstation.

### Out of Scope

- Multiple simultaneous Kokoro inference jobs.
- WebSocket transport.
- Seeking before the WebM stream is complete.
- Resuming a partially failed stream.
- GPU-based Opus encoding.
- System-wide auto-start or registry-based startup.
- Greasy Fork publication.
- General restructuring of the existing server or tray application.

## Architecture

### New Module: `audio_encoding.py`

`audio_encoding.py` owns all encoding-specific behavior:

- Resolve the bundled FFmpeg executable with
  `imageio_ffmpeg.get_ffmpeg_exe()`.
- Validate FFmpeg availability.
- Encode a complete mono float32 PCM array as OGG/Opus.
- Start and manage a continuous WebM/Opus FFmpeg subprocess.
- Convert numpy audio segments to little-endian float32 PCM bytes.
- Expose typed encoding errors that the API can map to safe HTTP responses.

`server.py` remains responsible for request validation, inference locking,
pipeline selection, HTTP negotiation, response headers, and lifecycle logs.

### Dependency Changes

`imageio-ffmpeg` is added to both runtime and test requirements. `setup.bat`
verifies:

- `imageio_ffmpeg` imports successfully.
- `get_ffmpeg_exe()` returns an existing executable.
- The executable can run `-version`.

No separate FFmpeg PATH check is introduced.

## Complete Audio Endpoint

### Request

`POST /tts` keeps the existing JSON body:

```json
{
  "text": "Hello world",
  "voice": "af_bella",
  "speed": 0.8
}
```

An optional query parameter selects the output:

```text
POST /tts?format=wav
POST /tts?format=ogg
```

### Format Negotiation

Negotiation order is deterministic:

1. A `format` query parameter takes priority.
2. Without `format`, explicit `Accept: audio/ogg` selects OGG/Opus.
3. `Accept: audio/wav`, `Accept: */*`, or no `Accept` selects WAV.
4. An unknown `format` value returns `406 Not Acceptable`.
5. An `Accept` header that explicitly excludes both supported formats returns
   `406 Not Acceptable`.

The compatibility default remains WAV.

### Responses

WAV:

```text
Content-Type: audio/wav
Content-Disposition: inline; filename="speech.wav"
```

OGG/Opus:

```text
Content-Type: audio/ogg
Content-Disposition: inline; filename="speech.ogg"
```

Both variants retain:

- `X-Inference-Time`
- `X-Audio-Duration`

OGG output must begin with the `OggS` container signature and contain an Opus
stream. FFmpeg encoding failures return a generic `500` response without
exposing local executable paths or command lines.

## Streaming Endpoint

### Request and Response

`POST /tts/stream` accepts the same `TTSRequest` JSON body.

Successful responses use:

```text
Content-Type: audio/webm; codecs="opus"
Cache-Control: no-store
X-Audio-Format: webm-opus
```

The response does not include `Content-Length`.

The endpoint format is fixed. It does not accept `format=ogg` because OGG is
not the selected MediaSource byte-stream container.

### FFmpeg Command Shape

The encoder consumes Kokoro's mono, 24 kHz float32 PCM:

```text
-f f32le -ar 24000 -ac 1 -i pipe:0
```

It produces low-latency WebM/Opus:

```text
-c:a libopus
-b:a 48k
-application voip
-frame_duration 20
-f webm
-cluster_time_limit 250
-cluster_size_limit 0
-flush_packets 1
pipe:1
```

Exact flags may be adjusted only if the bundled FFmpeg rejects a flag during
the initial test-first implementation. The output contract remains a
continuous MSE-compatible WebM stream containing Opus audio.

### Producer and Consumer Flow

The endpoint acquires the existing global `inference_lock` before starting
work. If acquisition exceeds the existing short busy timeout, it returns
`429`.

One producer thread performs the synchronous Kokoro iteration:

1. Select the American or British pipeline from the catalog language code.
2. Iterate Kokoro segments.
3. Convert each non-empty segment to contiguous float32 PCM.
4. Apply configured inter-segment silence.
5. Write PCM bytes to FFmpeg stdin immediately.
6. Close stdin after the final segment.

The async response generator reads FFmpeg stdout in bounded chunks and yields
them to `StreamingResponse`. Reading stdout and writing stdin occur
concurrently to avoid pipe deadlock.

Before returning `StreamingResponse`, the endpoint reads and validates the
first non-empty FFmpeg stdout chunk. This prefetched chunk must begin a valid
WebM/EBML stream and is yielded first by the response generator. If inference,
FFmpeg startup, or first-chunk production fails, cleanup runs and the endpoint
can still return a safe `500` because HTTP response headers have not been sent.

If `FADE_MS` is zero, each segment is written immediately. If `FADE_MS` is
positive, the producer keeps one segment of look-behind so it can apply the
configured fade-out to the true final segment without buffering the entire
utterance. The first segment receives the configured fade-in.

### Cancellation and Cleanup

The stream owns:

- A cancellation event.
- The producer thread.
- The FFmpeg subprocess.
- FFmpeg stdin/stdout/stderr handles.
- The acquired inference lock.

On normal completion, error, server shutdown, or client disconnect, cleanup is
idempotent:

1. Set the cancellation event.
2. Stop writing after the current Kokoro yield returns.
3. Close FFmpeg stdin.
4. Terminate FFmpeg if it has not exited.
5. Kill it only if termination times out.
6. Close all pipe handles.
7. Join the producer thread before allowing another inference request.
8. Release `inference_lock` exactly once.

Kokoro's active GPU call cannot be forcibly interrupted safely. The lock is
therefore held until the current yield returns and the producer thread exits.

### Error Semantics

FFmpeg availability is checked during application startup, before requests are
accepted.

Errors detected while prefetching the first WebM chunk produce a safe `500`
response. Once the prefetched chunk and HTTP response headers have been sent,
an encoder or inference failure closes the stream and is logged server-side;
HTTP status cannot be changed at that point.

No model, local path, FFmpeg command, or exception detail is returned to the
browser.

## Userscript Streaming Playback

### Capability Detection

Streaming is attempted only when all of these are available:

- `MediaSource`
- `MediaSource.isTypeSupported`
- Support for `audio/webm; codecs="opus"`
- Tampermonkey stream responses through
  `GM_xmlhttpRequest({ responseType: "stream" })`

Otherwise the script goes directly to OGG fallback.

### MediaSource Data Flow

The userscript:

1. Creates an `Audio` element and `MediaSource`.
2. Attaches the MediaSource object URL to the Audio element.
3. Creates one `SourceBuffer` for `audio/webm; codecs="opus"`.
4. Opens `/tts/stream` using `GM_xmlhttpRequest`.
5. Reads the returned `ReadableStream`.
6. Enqueues `Uint8Array` chunks.
7. Appends only when `SourceBuffer.updating` is false.
8. Waits for `updateend` before appending the next chunk.
9. Calls `mediaSource.endOfStream()` after the reader completes and the append
   queue is empty.

The queue has bounded pending bytes. Reading pauses while the queue is over the
limit, providing browser-side backpressure instead of unbounded memory growth.

### Fallback Commit Point

The script automatically retries with `/tts?format=ogg` when:

- MediaSource WebM/Opus is unsupported.
- The stream request cannot be established.
- The response is not a readable stream.
- SourceBuffer creation fails.
- The initialization segment or first media data cannot be appended or decoded.
- Playback fails before any audio has played.

The stream is considered committed after the `playing` event or after
`currentTime` becomes greater than zero. Failures after that point do not
restart from the beginning. The control displays a playback error and allows
the user to click again.

### Resource Lifecycle

Starting a new utterance or cancelling the current utterance releases every
resource exactly once:

- Abort the GM request.
- Cancel and release the stream reader.
- Clear pending append chunks.
- Remove SourceBuffer listeners.
- End or detach MediaSource.
- Pause and detach Audio.
- Revoke MediaSource and audio Blob URLs.
- Invalidate stale callbacks through the existing request-generation gate.

Cleanup functions remain pure or dependency-injected where practical so Node
tests can cover them without browser globals.

## Progress UI

The selected design is a horizontal fill button.

### States

`Connecting`

- Indeterminate animated fill.
- Text: `连接中`.

`Buffering`

- Indeterminate animated fill.
- Text includes elapsed playback time when playback has begun, such as
  `缓冲中 3.2s`.

`Playing, duration unknown`

- Animated fill continues.
- Text: `朗读中 8.4s`.
- No fabricated percentage is shown.

`Playing, duration known`

- Fill width is `currentTime / duration`.
- Text: `朗读中 62%`.

`OGG fallback`

- The control briefly labels the transition as `已回退 OGG`.
- Playback then uses accurate percentage progress from the complete audio file.

`Error`

- Error styling and concise retry text.

The progress calculation uses `audio.timeupdate`, `durationchange`, `playing`,
`waiting`, `ended`, and `error`. It never estimates progress from text length.

## Built-in Test Page

The test page adds a `流式模式` checkbox:

- Enabled: request `/tts/stream` and play through MediaSource.
- Disabled: request `/tts?format=ogg` and play the complete response.

The page uses the same capability detection, append-queue rules, fallback
policy, and progress semantics as the userscript, but no shared frontend build
system is introduced in this iteration.

The page visibly reports the active transport:

- `WebM/Opus stream`
- `OGG/Opus fallback`
- `WAV compatibility mode` when manually requested through API tools

## Windows Login Auto-start

### Storage and Shortcut

The feature uses the current user's Startup directory:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

The shortcut name is:

```text
Kokoro TTS.lnk
```

The shortcut target is the current absolute path to `Kokoro TTS.pyw`, and its
working directory is the project root.

PowerShell invokes `WScript.Shell.CreateShortcut` without requiring
administrator privileges. Paths are passed through environment variables
rather than interpolated into executable PowerShell source.

### Settings and Reconciliation

`tray_settings.json` gains:

```json
{
  "auto_start": false
}
```

The tray startup sequence reconciles saved intent with the shortcut:

- `auto_start: true`: create a missing shortcut or repair an outdated target.
- `auto_start: false`: remove this project's named shortcut if present.

The menu item is checkable and reports the actual verified shortcut state.

Enabling performs shortcut creation first, then saves `auto_start: true`.
Disabling removes the shortcut first, then saves `auto_start: false`.
If the filesystem or PowerShell operation fails, the prior setting remains
unchanged and a Windows message box reports the failure.

Only `Kokoro TTS.lnk` in the current user's Startup directory may be modified.

## Boundary and Concurrency Behavior

The API continues to accept any non-blank text up to the existing maximum.
Automated tests cover exact pass-through of:

- Punctuation-only text.
- Numeric text such as `I have 42 cats`.
- URLs.
- Mixed Chinese and English.

These tests verify request validation and pipeline invocation. They do not
claim that every Kokoro voice will pronounce every script naturally.

Concurrency tests cover:

- A complete request while a stream owns the lock.
- A stream request while a complete request owns the lock.
- Two stream requests.
- Cancellation followed by a new request.

Every competing request receives `429`; the next request succeeds after cleanup.

## Testing Strategy

### Python

The test suite moves to `pytest`, while existing `unittest.TestCase` tests remain
valid under pytest.

New tests cover:

- WAV default compatibility.
- OGG query negotiation.
- OGG Accept negotiation.
- Query precedence over Accept.
- `406` for unsupported formats.
- `OggS` signature and Opus encoding.
- WebM EBML signature and Opus stream.
- Streaming first-byte production before full producer completion.
- FFmpeg non-zero exit handling.
- Cancellation cleanup and lock release.
- Boundary text pass-through.
- Complete/stream concurrency competition.
- Shortcut creation, target validation, repair, deletion, and error paths.

Encoding tests use the bundled FFmpeg executable but fake Kokoro pipelines.
They do not download or load the model.

### JavaScript

Node tests cover:

- MediaSource capability selection.
- Serialized SourceBuffer appends.
- Bounded append queue behavior.
- Fallback before the playback commit point.
- No automatic replay after the commit point.
- Indeterminate elapsed-time state.
- Transition to accurate percentage.
- Idempotent cleanup of request, reader, media source, audio, and URLs.

DOM-heavy behavior is represented through small injected adapters rather than
requiring a full browser test framework in this iteration.

### CI

Windows GitHub Actions:

1. Installs runtime-light test dependencies including `pytest` and
   `imageio-ffmpeg`.
2. Verifies the bundled FFmpeg executable.
3. Runs catalog synchronization.
4. Runs Python compilation.
5. Runs `python -m pytest tests -v`.
6. Runs JavaScript syntax and Node tests.
7. Runs `pip check`.

### Local CUDA Verification

After restarting the service in the `kokoro-tts` environment:

- Health reports version `1.2.0`, `ready: true`, and `device: cuda`.
- American and British voices return valid OGG/Opus.
- A long `/tts/stream` request returns a WebM initialization segment before
  full inference completes.
- The complete WebM stream decodes successfully.
- Client cancellation leaves no FFmpeg child process and the next request
  succeeds.
- The running GPU remains the NVIDIA GeForce RTX 4070 Ti SUPER.

## Versioning and Documentation

- Server version: `1.2.0`.
- Userscript version: `1.4.0`.
- README and Chinese instructions document:
  - WebM/Opus streaming.
  - OGG negotiation.
  - MediaSource fallback.
  - Bundled FFmpeg dependency.
  - Login auto-start.
  - Updated test commands.
- A third-iteration report records implementation and validation results.

## Acceptance Criteria

The iteration is complete when:

1. Existing WAV clients behave unchanged.
2. `/tts?format=ogg` and `Accept: audio/ogg` return valid OGG/Opus.
3. `/tts/stream` returns a continuous, decodable WebM/Opus stream.
4. The userscript plays the stream through MediaSource on supported Chromium
   browsers.
5. Unsupported or early-failing streaming automatically falls back to OGG.
6. Progress never displays a fabricated percentage.
7. Cancelling playback releases browser, encoder, and inference resources.
8. Tray login auto-start can be enabled, repaired, and disabled without
   administrator rights.
9. Boundary and concurrency tests pass.
10. Windows CI and local CUDA smoke tests pass.

## References

- [Tampermonkey `GM_xmlhttpRequest`](https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest)
- [W3C WebM Byte Stream Format](https://www.w3.org/TR/mse-byte-stream-format-webm/)
- [Chrome MediaSource Opus support](https://developer.chrome.com/blog/media-updates-in-chrome-70)
