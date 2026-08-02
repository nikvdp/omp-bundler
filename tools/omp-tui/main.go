// Command omp-tui is a small terminal chat client for one omp-bundler HTTP
// agent. Supply the agent URL and chat synchronously: Enter sends, Ctrl+J
// inserts a newline, Ctrl+C quits. See tools/omp-tui/DESIGN.md.
package main

import (
	"errors"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Environ()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run parses arguments, validates the URL, builds the client and model, and
// starts the Bubble Tea program. It is separated from main for testability.
func run(args []string, env []string) error {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Print(helpText())
		return nil
	}
	if len(args) > 0 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Printf("omp-tui %s\n", version)
		return nil
	}
	if len(args) != 1 {
		return errors.New("usage: omp-tui [--version] <agent-url>")
	}
	rawURL := args[0]

	token := envValue(env, "OMP_HTTP_API_TOKEN")

	client, err := NewClient(rawURL, token)
	if err != nil {
		return err
	}
	key, err := newConversationKey()
	if err != nil {
		return err
	}

	model := NewModel(client.Endpoint(), key, client.Send, 80, 24)
	p := tea.NewProgram(model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		return fmt.Errorf("run: %w", err)
	}
	return nil
}

// envValue returns the first value for name in a KEY=VALUE environment slice.
// It mirrors os.Getenv without requiring the process environment.
func envValue(env []string, name string) string {
	prefix := name + "="
	for _, kv := range env {
		if len(kv) > len(prefix) && kv[:len(prefix)] == prefix {
			return kv[len(prefix):]
		}
	}
	return ""
}

// helpText returns the --help banner printed to stdout.
func helpText() string {
	return `omp-tui [--version] <agent-url>

Chat with one running omp-bundler HTTP agent from the terminal.

Usage:
  omp-tui http://localhost:8765/v1/agents/my-agent

The agent URL identifies exactly one agent. Each launch starts a fresh
server-side conversation. Responses are synchronous with a spinner; streaming
is not currently supported.

Environment:
  OMP_HTTP_API_TOKEN  optional Bearer token for the agent endpoint

Keys:
  Enter      send a nonblank message
  Ctrl+J     insert a newline
  PgUp/PgDn  scroll the transcript
  Ctrl+C     quit
`
}
