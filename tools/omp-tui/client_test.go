package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestParseAgentURL covers URL validation and trailing-slash normalization.
func TestParseAgentURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		wantErr bool
		want    string // expected Endpoint() when not an error
	}{
		{"http", "http://localhost:8765/v1/agents/meetings-agent", false, "http://localhost:8765/v1/agents/meetings-agent"},
		{"https", "https://example.com/v1/agents/x", false, "https://example.com/v1/agents/x"},
		{"trailing slash trimmed", "http://localhost:8765/v1/agents/x/", false, "http://localhost:8765/v1/agents/x"},
		{"double trailing slash", "http://h/a/b//", false, "http://h/a/b"},
		{"empty", "", true, ""},
		{"relative", "/v1/agents/x", true, ""},
		{"unsupported scheme", "ftp://h/a", true, ""},
		{"missing host", "http:///v1/agents/x", true, ""},
		{"query rejected", "http://h/a?x=1", true, ""},
		{"fragment rejected", "http://h/a#frag", true, ""},
		{"userinfo rejected", "http://user:pass@h/a", true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cl, err := NewClient(c.in, "")
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got nil", c.in)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", c.in, err)
			}
			if got := cl.Endpoint(); got != c.want {
				t.Errorf("endpoint: got %q, want %q", got, c.want)
			}
		})
	}
}

// TestComposeEndpoint verifies the POST URL preserves the supplied agent path
// and safely encodes the conversation key.
func TestComposeEndpoint(t *testing.T) {
	cl, err := NewClient("http://localhost:8765/v1/agents/meetings-agent", "")
	if err != nil {
		t.Fatal(err)
	}
	got := composeEndpoint(cl.baseURL, "abc123")
	want := "http://localhost:8765/v1/agents/meetings-agent/conversations/abc123/messages"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestComposeEndpointTrailingSlash confirms normalization survives a trailing slash.
func TestComposeEndpointTrailingSlash(t *testing.T) {
	cl, err := NewClient("http://h/v1/agents/x/", "")
	if err != nil {
		t.Fatal(err)
	}
	got := composeEndpoint(cl.baseURL, "k")
	want := "http://h/v1/agents/x/conversations/k/messages"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// TestSendRequest verifies POST method, JSON body, content type, and the
// optional Bearer header, plus the absence of Authorization when unset.
func TestSendRequest(t *testing.T) {
	var gotMethod, gotBody, gotCT, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotCT = r.Header.Get("Content-Type")
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"hi","agentId":"a","usage":{"input":1}}`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "key1", "hello")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method: got %q, want POST", gotMethod)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type: got %q, want application/json", gotCT)
	}
	if gotAuth != "" {
		t.Errorf("authorization should be empty when no token, got %q", gotAuth)
	}
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(gotBody), &payload); err != nil {
		t.Fatalf("body not valid JSON: %v (body=%q)", err, gotBody)
	}
	if payload.Message != "hello" {
		t.Errorf("body message: got %q, want %q", payload.Message, "hello")
	}
}

// TestSendBearerToken confirms the Bearer header is sent when a token is set.
func TestSendBearerToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"ok"}`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "k", "m")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer secret-token" {
		t.Errorf("authorization: got %q, want Bearer secret-token", gotAuth)
	}
}

// TestSendSuccessDecode verifies the text field is decoded and extra fields
// are tolerated.
func TestSendSuccessDecode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"hello back","agentId":"x","conversationKey":"k","correlationId":"c","attachments":[],"usage":{"input":1,"output":1}}`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	text, err := cl.Send(context.Background(), "k", "hi")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if text != "hello back" {
		t.Errorf("text: got %q, want %q", text, "hello back")
	}
}

// TestSendMissingText verifies a 2xx response with missing text is an error.
func TestSendMissingText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agentId":"x"}`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "k", "hi")
	if err == nil {
		t.Fatal("expected error for missing text, got nil")
	}
	if !strings.Contains(err.Error(), "missing text") {
		t.Errorf("error should mention missing text, got %q", err.Error())
	}
}

// TestSendMalformedJSON verifies a 2xx response with malformed JSON is an error.
func TestSendMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "k", "hi")
	if err == nil {
		t.Fatal("expected error for malformed JSON, got nil")
	}
}

// TestSendServerErrorDecoded verifies a structured {"error":"..."} body is used.
func TestSendServerErrorDecoded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"model unavailable"}`))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "k", "hi")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "model unavailable") {
		t.Errorf("error should contain server message, got %q", err.Error())
	}
}

// TestSendServerErrorFallback verifies a bounded fallback excerpt is used when
// no structured error is present.
func TestSendServerErrorFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream is down"))
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = cl.Send(context.Background(), "k", "hi")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("error should contain status 502, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "upstream is down") {
		t.Errorf("error should contain body excerpt, got %q", err.Error())
	}
}

// TestSendCanceled verifies a cancelled context surfaces as a cancellation
// error, not a generic transport error.
func TestSendCanceled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block until the handler is cancelled so the client context wins.
		<-r.Context().Done()
	}))
	defer srv.Close()

	cl, err := NewClient(srv.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = cl.Send(ctx, "k", "hi")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsCanceled(err) {
		t.Errorf("expected IsCanceled true, got false (%q)", err.Error())
	}
}

// TestNewConversationKeyFormat verifies the generated key is a 32-char hex
// string and two calls produce distinct keys.
func TestNewConversationKeyFormat(t *testing.T) {
	k1, err := newConversationKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(k1) != 32 {
		t.Errorf("key length: got %d, want 32", len(k1))
	}
	k2, err := newConversationKey()
	if err != nil {
		t.Fatal(err)
	}
	if k1 == k2 {
		t.Error("two consecutive keys should differ")
	}
}
