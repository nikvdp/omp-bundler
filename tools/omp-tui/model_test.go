package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// fakeSend is a deterministic sendFunc for model tests. It records the
// conversation key and message of each call and returns the configured result.
type fakeSend struct {
	key   string
	msgs  []string
	text  string
	err   error
	calls int
}

func (f *fakeSend) send(ctx context.Context, key, message string) (string, error) {
	f.calls++
	f.key = key
	f.msgs = append(f.msgs, message)
	return f.text, f.err
}

// newTestModel builds a Model with an injected sender and a fixed conversation
// key so tests can assert reuse.
func newTestModel(send sendFunc) Model {
	return NewModel("http://localhost:8765/v1/agents/test", "fixed-key", send, 80, 24)
}

// update runs one Update on the model and returns the resulting Model.
func update(t *testing.T, m Model, msg tea.Msg) Model {
	t.Helper()
	mm, _ := m.Update(msg)
	got, ok := mm.(Model)
	if !ok {
		t.Fatalf("Update did not return Model: %T", mm)
	}
	return got
}

// execCmd runs a tea.Cmd if non-nil and returns the resulting message (or nil).
func execCmd(cmd tea.Cmd) tea.Msg {
	if cmd == nil {
		return nil
	}
	return cmd()
}

// TestConversationKeyReused verifies the same conversation key is supplied to
// every send across multiple turns in one model instance.
func TestConversationKeyReused(t *testing.T) {
	fs := &fakeSend{text: "ok"}
	m := newTestModel(fs.send)

	// Turn 1
	m = sendOne(t, m, "first")
	if fs.key != "fixed-key" {
		t.Errorf("turn 1 key: got %q, want fixed-key", fs.key)
	}
	// Turn 2
	m = sendOne(t, m, "second")
	if fs.key != "fixed-key" {
		t.Errorf("turn 2 key: got %q, want fixed-key", fs.key)
	}
	if fs.calls != 2 {
		t.Errorf("send calls: got %d, want 2", fs.calls)
	}
	if len(fs.msgs) != 2 || fs.msgs[0] != "first" || fs.msgs[1] != "second" {
		t.Errorf("messages: got %v, want [first second]", fs.msgs)
	}
}

// sendOne simulates a full send cycle: Enter to start, execute the command,
// deliver the sendResultMsg.
func sendOne(t *testing.T, m Model, text string) Model {
	t.Helper()
	// Type text into the textarea by sending each rune.
	for _, r := range text {
		m = update(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	// Press Enter to send.
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(Model)
	if !m.pending {
		t.Fatalf("expected pending after Enter, got pending=%v", m.pending)
	}
	// Execute the command and deliver the result.
	result := execCmd(cmd)
	if result == nil {
		t.Fatal("expected a command after Enter, got nil")
	}
	m = update(t, m, result)
	return m
}

// TestEnterSendsNonblank verifies Enter on an empty composer does not send.
func TestEnterSendsNonblank(t *testing.T) {
	fs := &fakeSend{text: "ok"}
	m := newTestModel(fs.send)
	m = update(t, m, tea.KeyMsg{Type: tea.KeyEnter})
	if m.pending {
		t.Error("Enter on empty composer should not start a send")
	}
	if fs.calls != 0 {
		t.Errorf("send calls: got %d, want 0", fs.calls)
	}
}

// TestEnterIgnoredWhilePending verifies Enter is ignored while pending.
func TestEnterIgnoredWhilePending(t *testing.T) {
	fs := &fakeSend{text: "ok"}
	m := newTestModel(fs.send)
	// Start a send with "hi".
	m = sendOne(t, m, "hi")
	if m.pending {
		t.Fatal("model should not be pending after a completed send")
	}

	// Now start a send and do not deliver the result; while pending, Enter
	// must not start a second send.
	for _, r := range "again" {
		m = update(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	mm, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(Model)
	if !m.pending {
		t.Fatal("expected pending after first Enter")
	}
	// Press Enter again while pending.
	mm2, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m2 := mm2.(Model)
	if !m2.pending {
		t.Error("Enter while pending should not change pending state")
	}
	// Only one send should have been dispatched so far.
	if fs.calls != 1 {
		t.Errorf("send calls while pending: got %d, want 1", fs.calls)
	}
}

// TestCtrlJNewline verifies Ctrl+J inserts a newline into the composer.
func TestCtrlJNewline(t *testing.T) {
	fs := &fakeSend{text: "ok"}
	m := newTestModel(fs.send)
	// Type "a"
	m = update(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	// Ctrl+J
	m = update(t, m, tea.KeyMsg{Type: tea.KeyCtrlJ})
	// Type "b"
	m = update(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	val := m.textarea.Value()
	if !strings.Contains(val, "a") || !strings.Contains(val, "b") {
		t.Errorf("composer value: got %q, want a newline between a and b", val)
	}
	if m.textarea.LineCount() < 2 {
		t.Errorf("expected at least 2 lines after Ctrl+J, got %d (value=%q)", m.textarea.LineCount(), val)
	}
}

// TestSuccessResultAppendsAndRestores verifies a successful sendResultMsg stops
// pending, appends agent text to the transcript, and restores input.
func TestSuccessResultAppendsAndRestores(t *testing.T) {
	fs := &fakeSend{text: "agent reply"}
	m := newTestModel(fs.send)
	m = sendOne(t, m, "hi")
	if m.pending {
		t.Error("pending should be false after a successful result")
	}
	// The transcript should contain the user message and the agent reply.
	var texts []string
	for _, e := range m.transcript {
		texts = append(texts, e.text)
	}
	if len(texts) != 2 {
		t.Fatalf("transcript entries: got %d, want 2 (%v)", len(texts), texts)
	}
	if texts[0] != "hi" {
		t.Errorf("transcript[0]: got %q, want hi", texts[0])
	}
	if texts[1] != "agent reply" {
		t.Errorf("transcript[1]: got %q, want agent reply", texts[1])
	}
	if !m.textarea.Focused() {
		t.Error("textarea should be focused after result")
	}
}

// TestErrorResultAppendsAndRestores verifies an error result stops pending,
// appends a visible error, preserves prior transcript, and restores input.
func TestErrorResultAppendsAndRestores(t *testing.T) {
	fs := &fakeSend{err: errors.New("boom")}
	m := newTestModel(fs.send)
	m = sendOne(t, m, "hi")
	if m.pending {
		t.Error("pending should be false after an error result")
	}
	var texts []string
	for _, e := range m.transcript {
		texts = append(texts, e.text)
	}
	if len(texts) != 2 {
		t.Fatalf("transcript entries: got %d, want 2 (%v)", len(texts), texts)
	}
	if texts[0] != "hi" {
		t.Errorf("transcript[0]: got %q, want hi", texts[0])
	}
	if !strings.Contains(texts[1], "boom") {
		t.Errorf("transcript[1] should contain error, got %q", texts[1])
	}
	if !m.textarea.Focused() {
		t.Error("textarea should be focused after error result")
	}
}

// TestCanceledResultNoTranscript verifies a cancelled result (Ctrl+C) does not
// surface an error in the transcript.
func TestCanceledResultNoTranscript(t *testing.T) {
	fs := &fakeSend{err: errCanceled}
	m := newTestModel(fs.send)
	// Type and send.
	for _, r := range "hi" {
		m = update(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	mm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(Model)
	result := execCmd(cmd)
	m = update(t, m, result)
	if m.pending {
		t.Error("pending should be false after cancelled result")
	}
	// Only the user message should be in the transcript; no error entry.
	for _, e := range m.transcript {
		if e.role == roleError {
			t.Errorf("transcript should not contain an error entry for cancellation, got %q", e.text)
		}
	}
}

// TestResizeNoPanic verifies WindowSizeMsg on narrow and normal dimensions does
// not panic and the transcript remains renderable via View().
func TestResizeNoPanic(t *testing.T) {
	fs := &fakeSend{text: "ok"}
	m := newTestModel(fs.send)
	m = sendOne(t, m, "hello world this is a longer message")
	sizes := []tea.WindowSizeMsg{
		{Width: 1, Height: 1},
		{Width: 5, Height: 3},
		{Width: 20, Height: 10},
		{Width: 80, Height: 24},
		{Width: 200, Height: 50},
	}
	for _, s := range sizes {
		m = update(t, m, s)
		// View must not panic and must produce a string.
		view := m.View()
		if view == "" {
			t.Errorf("View() empty after resize to %v", s)
		}
	}
}

// TestViewRendersTranscript verifies View() includes user and agent text after a
// successful turn.
func TestViewRendersTranscript(t *testing.T) {
	fs := &fakeSend{text: "agent says hi"}
	m := newTestModel(fs.send)
	m = sendOne(t, m, "user says hello")
	view := m.View()
	if !strings.Contains(view, "user says hello") {
		t.Errorf("View should contain user message, got:\n%s", view)
	}
	if !strings.Contains(view, "agent says hi") {
		t.Errorf("View should contain agent message, got:\n%s", view)
	}
}
