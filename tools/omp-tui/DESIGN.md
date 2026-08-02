# URL-targeted OMP agent TUI design

## Goal

Add a small Go terminal chat client at `tools/omp-tui/`. A user supplies the
URL of one running omp-bundler HTTP agent and immediately gets a basic
conversational interface.

```text
omp-tui http://localhost:8765/v1/agents/meetings-agent
```

The URL is the only required input. The program talks to the existing
synchronous endpoint; it does not discover agents, start Docker, inspect
bundle files, or manage deployments.

## User contract

### Invocation

```text
omp-tui [--version] <agent-url>
```

`<agent-url>` is an absolute `http` or `https` URL naming one agent, normally:

```text
http://host:8765/v1/agents/<agent-id>
```

The client trims a trailing slash and appends:

```text
/conversations/<ephemeral-conversation-key>/messages
```

Reject missing URLs, extra positional arguments, unsupported schemes, missing
hosts, query strings, and fragments before starting the TUI. Do not add a
config file or agent-selection flag.

If `OMP_HTTP_API_TOKEN` is nonempty, send it as `Authorization: Bearer <value>`.
Do not accept a token flag, persist it, print it, or include it in errors.

### Conversation identity

Generate one cryptographically random conversation key at process startup using
the Go standard library. Reuse it for every turn in that process. Do not
persist it or expose a resume/history option. A restart intentionally starts a
new server-side conversation.

### Interaction

- Scrollable transcript with clearly distinct `You` and `Agent` messages.
- Multiline composer focused at startup.
- Enter sends a nonblank message.
- Ctrl+J inserts a newline.
- Page Up/Page Down scroll transcript; new messages return the viewport to the
  bottom.
- While a request is pending: append the user's message immediately, clear the
  composer, disable additional sends, and show a spinner/status line.
- On success: append response `text`, stop the spinner, and re-enable the
  composer.
- On failure: append a concise visible error, stop the spinner, preserve prior
  transcript, and allow retry by typing a new message.
- Ctrl+C quits. A request uses a cancelable context so quitting does not leave
  client work running.
- Handle terminal resize and narrow terminals without panics.
- Plain text only. No Markdown renderer, attachments, tool events, usage pane,
  timestamps, mouse controls, local history, themes, or streaming.

## Existing HTTP contract

Request:

```http
POST <agent-url>/conversations/<key>/messages
Content-Type: application/json
Authorization: Bearer <token>  # only when configured

{"message":"..."}
```

Success response:

```json
{
  "agentId": "meetings-agent",
  "conversationKey": "opaque-client-key",
  "correlationId": "opaque-core-id",
  "text": "response text",
  "attachments": [],
  "usage": {
    "input": 1,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "costUsd": 0
  }
}
```

The TUI only needs `text`; decoding tolerates additional response fields. A
2xx response with missing `text`, malformed JSON, non-2xx response, or
transport failure is an error. For non-2xx responses, decode the server's
`{"error":"..."}` when possible; otherwise report the HTTP status and a bounded
response-body excerpt. The client never echoes request headers or tokens. The
request context, not a short `http.Client.Timeout`, governs cancellation,
because the synchronous server may legitimately wait for a long agent turn.

## Implementation shape

Use Go 1.24 and the established Charmbracelet stack:

- Bubble Tea for the update loop and commands
- Bubbles `textarea`, `viewport`, and `spinner`
- Lip Gloss for minimal role/status styling

Keep the module self-contained under `tools/omp-tui/`. Prefer a small number
of files:

```text
tools/omp-tui/
  DESIGN.md
  go.mod
  go.sum
  main.go
  client.go
  model.go
  client_test.go
  model_test.go
```

Do not create internal packages or interfaces with one implementation.

### Transport

A concrete `Client` owns the validated base URL, optional token, and
`http.Client`. Its send method accepts context, conversation key, and message,
then returns response text or an error. URL composition percent-encodes the
generated conversation key and preserves the supplied agent path.

### Bubble Tea state

One model owns:

- endpoint display label (sanitized URL without userinfo/query/fragment)
- generated conversation key
- concrete client/send function
- viewport
- textarea
- spinner
- transcript messages
- terminal width and height
- `pending` boolean
- request cancel function if needed
- transient/fatal error state only where required

Network work runs in a Bubble Tea command and returns one result message.
`Update` never blocks. Enter is ignored while `pending`; all state transitions
happen on the update loop.

Transcript rendering rebuilds a bounded string from the in-memory message
slice on each append/resize; this is a small interactive client and does not
need a virtualized message store. Message text is preserved verbatim and
wrapped to the current viewport width.

### Errors and exit codes

Argument/URL validation errors print one concise line to stderr and exit
nonzero without entering alternate-screen mode. Runtime request errors appear
in the transcript and do not exit. Initialization failures exit nonzero. Normal
Ctrl+C exits zero.

## Verification contract

Focused tests cover observable behavior:

1. URL validation and endpoint construction.
2. POST method, JSON body, content type, optional Bearer header, and no
   Authorization header when unset.
3. Success decoding, malformed success payload, server error decoding, bounded
   fallback error, and transport cancellation.
4. One conversation key reused across multiple sends in one model instance.
5. Enter sends only nonblank text while idle; Enter is ignored while pending;
   Ctrl+J adds a newline.
6. Reply and error results stop the spinner/pending state and restore input.
7. Resize does not panic and the transcript remains renderable.

Run:

```text
cd tools/omp-tui
go test ./...
go build ./...
go run . --help
```

For a smoke check, run a local `httptest`-equivalent fake synchronous agent or a
tiny disposable server, launch the compiled program in a PTY, send one line,
and observe both the user message and returned agent text. The check does not
require Docker, model credentials, or a live Pumble service.

## Documentation

Add a short root README section showing installation/build and:

```text
OMP_HTTP_API_TOKEN=... ./omp-tui http://localhost:8765/v1/agents/my-agent
```

State that the URL identifies one agent, conversations are ephemeral per
process, responses are synchronous with a spinner, and streaming is not
currently supported.

## Deferred streaming seam

Do not modify the HTTP adapter now. Keep transport result delivery behind a
Bubble Tea command/message boundary so a future SSE transport can emit
incremental messages without changing composer, viewport, or transcript
ownership. This version adds no speculative streaming types or interfaces.
