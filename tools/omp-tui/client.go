package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// maxErrorBody is the bounded length of a server error body excerpt reported
// to the user when no structured {"error":"..."} payload is available.
const maxErrorBody = 512

// Client posts chat turns to one omp-bundler HTTP agent. It owns the validated
// base agent URL, an optional Bearer token, and the HTTP transport. All
// network work happens through Send; the caller drives it from a Bubble Tea
// command so Update never blocks.
type Client struct {
	baseURL *url.URL // validated, trailing slash trimmed, no query/fragment
	token   string   // optional Bearer token; never logged
	http    *http.Client
}

// sendFunc is the concrete send signature used by the model. Keeping it as a
// named function type lets tests inject a deterministic sender without
// introducing an interface with a single production implementation.
type sendFunc func(ctx context.Context, conversationKey, message string) (string, error)

// NewClient validates rawURL and returns a Client ready to post turns. The
// token is read from the environment by the caller and passed in here; it is
// never printed or persisted by the client.
func NewClient(rawURL, token string) (*Client, error) {
	u, err := parseAgentURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &Client{
		baseURL: u,
		token:   token,
		http:    &http.Client{},
	}, nil
}

// Endpoint returns a sanitized display label for the agent URL: the scheme,
// host, and path without userinfo, query, or fragment. It is safe to show in
// the TUI and never contains the token.
func (c *Client) Endpoint() string {
	return c.baseURL.String()
}

// Send posts one message turn to the synchronous agent endpoint and returns
// the response text. It honors ctx cancellation, never echoes headers or the
// token, and reports bounded, safe errors on failure.
func (c *Client) Send(ctx context.Context, conversationKey, message string) (string, error) {
	endpoint := composeEndpoint(c.baseURL, conversationKey)

	body, err := json.Marshal(struct {
		Message string `json:"message"`
	}{
		Message: message,
	})
	if err != nil {
		return "", fmt.Errorf("encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return "", errCanceled
		}
		return "", fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		return "", decodeServerError(resp)
	}

	var payload struct {
		Text string `json:"text"`
		// Additional fields (agentId, conversationKey, correlationId,
		// attachments, usage) are tolerated and ignored.
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if payload.Text == "" {
		return "", errors.New("response missing text")
	}
	return payload.Text, nil
}

// parseAgentURL validates a user-supplied agent URL and returns it normalized
// for endpoint construction. It rejects relative URLs, unsupported schemes,
// missing hosts, query strings, and fragments, and trims a trailing slash.
// The returned URL carries only scheme, host, and path.
func parseAgentURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("missing agent URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if !u.IsAbs() {
		return nil, errors.New("URL must be absolute")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme %q (want http or https)", u.Scheme)
	}
	if u.Host == "" {
		return nil, errors.New("URL missing host")
	}
	if u.User != nil {
		return nil, errors.New("userinfo is not allowed in the agent URL")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return nil, errors.New("query strings are not allowed in the agent URL")
	}
	if u.Fragment != "" {
		return nil, errors.New("fragments are not allowed in the agent URL")
	}
	u.User = nil
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	u.RawFragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	if u.Path == "" {
		u.Path = ""
	}
	return u, nil
}

// composeEndpoint builds the per-turn POST URL by appending the conversation
// path to the validated base URL. The conversation key is percent-encoded so
// arbitrary random bytes are safe in the path segment.
func composeEndpoint(base *url.URL, conversationKey string) string {
	segments := strings.Split(base.Path, "/")
	segments = append(segments, "conversations", conversationKey, "messages")
	cleaned := make([]string, 0, len(segments))
	for _, s := range segments {
		if s != "" {
			cleaned = append(cleaned, s)
		}
	}
	u := *base
	u.Path = "/" + strings.Join(cleaned, "/")
	return u.String()
}

// newConversationKey generates one cryptographically random conversation key
// for the process. It is reused for every turn until the program exits.
func newConversationKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate conversation key: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// errCanceled is returned when the request context is cancelled (e.g. the
// user quit with Ctrl+C). It carries no request or token detail.
var errCanceled = errors.New("request canceled")

// IsCanceled reports whether err is the cancellation sentinel or context
// cancellation. The TUI uses it to decide whether to surface a visible error
// (Ctrl+C quit discards it) or a recoverable transport error.
func IsCanceled(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, errCanceled) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// decodeServerError reads a non-2xx response and returns a concise, safe error
// that never echoes headers or the token. It prefers a structured
// {"error":"..."} body and falls back to the HTTP status plus a bounded body
// excerpt.
func decodeServerError(resp *http.Response) error {
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody+1))
	if err != nil {
		return fmt.Errorf("server returned %d (could not read body)", resp.StatusCode)
	}
	if len(body) > 0 {
		var structured struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &structured) == nil && structured.Error != "" {
			return fmt.Errorf("server error (%d): %s", resp.StatusCode, structured.Error)
		}
	}
	excerpt := strings.TrimSpace(string(body))
	if len(excerpt) > maxErrorBody {
		excerpt = excerpt[:maxErrorBody]
	}
	if excerpt == "" {
		return fmt.Errorf("server returned %d with an empty body", resp.StatusCode)
	}
	return fmt.Errorf("server returned %d: %s", resp.StatusCode, excerpt)
}
