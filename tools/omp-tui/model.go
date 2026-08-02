package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// role identifies a transcript speaker.
type role int

const (
	roleUser role = iota
	roleAgent
	roleError
)

// transcriptEntry is one rendered line in the in-memory transcript. The text
// is preserved verbatim; styling is applied at render time.
type transcriptEntry struct {
	role role
	text string
}

// sendResultMsg is the single Bubble Tea message delivered when a network turn
// completes. It carries the response text or an error. Keeping this as a
// dedicated command/message boundary means a future SSE transport can emit
// incremental messages without changing composer, viewport, or transcript
// ownership.
type sendResultMsg struct {
	text string
	err  error
}

// Model owns all chat TUI state. Update never blocks; network work runs as a
// command and returns sendResultMsg.
type Model struct {
	endpoint        string
	conversationKey string
	send            sendFunc

	viewport viewport.Model
	textarea textarea.Model
	spinner  spinner.Model

	transcript []transcriptEntry

	width  int
	height int

	pending bool
	cancel  context.CancelFunc
}

// lipgloss styles. Bold role labels give distinct You/Agent/Error lines in
// color and monochrome terminals without depending on a theme.
var (
	youStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("36"))
	agentStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("35"))
	errorStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("203"))
	normalStyle = lipgloss.NewStyle()
	faintStyle  = lipgloss.NewStyle().Faint(true)
)

// NewModel builds the chat model. It validates nothing; the caller validates
// the URL and conversation key first. The composer is focused at startup.
func NewModel(endpoint, conversationKey string, send sendFunc, width, height int) Model {
	vp := viewport.New(width, composerHeight(height))
	vp.SetContent("")

	ta := textarea.New()
	ta.Prompt = "│ "
	ta.Placeholder = "Type a message. Enter to send, Ctrl+J for a newline, Ctrl+C to quit."
	ta.ShowLineNumbers = false
	ta.SetWidth(width)
	ta.SetHeight(3)
	ta.Focus()

	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(lipgloss.NewStyle().Foreground(lipgloss.Color("35"))),
	)

	return Model{
		endpoint:        endpoint,
		conversationKey: conversationKey,
		send:            send,
		viewport:        vp,
		textarea:        ta,
		spinner:         sp,
		width:           width,
		height:          height,
		transcript:      nil,
		pending:         false,
	}
}

// Init starts the textarea cursor and is otherwise a no-op.
func (m Model) Init() tea.Cmd {
	return textarea.Blink
}

// Update handles all messages. It never blocks; network turns are dispatched as
// commands that return sendResultMsg.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.viewport.Width = msg.Width
		m.viewport.Height = composerHeight(msg.Height)
		m.textarea.SetWidth(msg.Width)
		m.refreshTranscript()
		return m, nil

	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			if m.cancel != nil {
				m.cancel()
			}
			return m, tea.Quit

		case tea.KeyPgUp:
			m.viewport.LineUp(m.viewport.Height)
			return m, nil

		case tea.KeyPgDown:
			m.viewport.LineDown(m.viewport.Height)
			return m, nil

		case tea.KeyEnter:
			if m.pending {
				return m, nil
			}
			text := strings.TrimSpace(m.textarea.Value())
			if text == "" {
				return m, nil
			}
			return m.startSend(text)

		case tea.KeyCtrlJ:
			m.textarea, _ = m.textarea.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'\n'}})
			return m, nil
		}

		// Fall through to the textarea for ordinary typing/navigation.
		var cmd tea.Cmd
		m.textarea, cmd = m.textarea.Update(msg)
		return m, cmd

	case sendResultMsg:
		m.pending = false
		m.cancel = nil
		if msg.err != nil {
			if IsCanceled(msg.err) {
				// Ctrl+C already requested quit; do not surface an error.
				return m, nil
			}
			m.appendTranscript(roleError, msg.err.Error())
		} else {
			m.appendTranscript(roleAgent, msg.text)
		}
		m.textarea.Focus()
		m.refreshTranscript()
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	default:
		// Forward to textarea and viewport so cursor blink and other widget
		// internals keep working.
		var cmd tea.Cmd
		m.textarea, cmd = m.textarea.Update(msg)
		vp, vcmd := m.viewport.Update(msg)
		m.viewport = vp
		return m, tea.Batch(cmd, vcmd)
	}
}

// startSend appends the user's message, clears the composer, flips to pending,
// and launches the network turn as a command that returns sendResultMsg.
func (m Model) startSend(text string) (tea.Model, tea.Cmd) {
	m.appendTranscript(roleUser, text)
	m.textarea.Reset()
	m.pending = true
	m.refreshTranscript()

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	conv := m.conversationKey
	send := m.send
	msg := text

	return m, func() tea.Msg {
		resp, err := send(ctx, conv, msg)
		return sendResultMsg{text: resp, err: err}
	}
}

// appendTranscript records one verbatim entry and snaps the viewport to the
// bottom so the newest message is visible.
func (m *Model) appendTranscript(r role, text string) {
	m.transcript = append(m.transcript, transcriptEntry{role: r, text: text})
	m.viewport.GotoBottom()
}

// refreshTranscript rebuilds the bounded transcript string from the in-memory
// slice and feeds it to the viewport. This is a small interactive client and
// does not need a virtualized message store.
func (m *Model) refreshTranscript() {
	var b strings.Builder
	for _, e := range m.transcript {
		label, style := roleLabel(e.role)
		body := wrapText(e.text, max(m.width-labelWidth(), 1))
		fmt.Fprintf(&b, "%s %s\n", style.Render(label), normalStyle.Render(body))
	}
	m.viewport.SetContent(b.String())
	m.viewport.GotoBottom()
}

// View renders the whole screen: transcript viewport on top, status or
// composer prompt below.
func (m Model) View() string {
	status := m.statusLine()
	composer := m.textarea.View()
	return lipgloss.JoinVertical(lipgloss.Left,
		m.viewport.View(),
		status,
		composer,
	)
}

// statusLine returns the line shown between the transcript and composer. While
// pending it shows the spinner plus an endpoint hint; otherwise it shows a
// compact help line.
func (m Model) statusLine() string {
	if m.pending {
		return fmt.Sprintf("%s waiting for %s …", m.spinner.View(), faintStyle.Render(m.endpoint))
	}
	return faintStyle.Render("Enter: send  Ctrl+J: newline  PgUp/PgDn: scroll  Ctrl+C: quit")
}

// composerHeight returns the viewport height given the total terminal height.
// Reserve space for the composer and the status line.
func composerHeight(total int) int {
	if total <= 5 {
		return 1
	}
	return total - 4
}

// roleLabel returns the speaker label and its style for one transcript entry.
func roleLabel(r role) (string, lipgloss.Style) {
	switch r {
	case roleUser:
		return "You", youStyle
	case roleAgent:
		return "Agent", agentStyle
	case roleError:
		return "Error", errorStyle
	default:
		return "?", normalStyle
	}
}

// labelWidth is the printed width of "You "/"Agent "/"Error " prefixes plus the
// separating space used in refreshTranscript.
func labelWidth() int {
	return 6
}

// wrapText hard-wraps text to the given width, preserving explicit newlines.
// It keeps message text verbatim while staying renderable in narrow terminals.
func wrapText(text string, width int) string {
	if width < 1 {
		width = 1
	}
	var b strings.Builder
	for i, line := range strings.Split(text, "\n") {
		if i > 0 {
			b.WriteByte('\n')
		}
		for len(line) > width {
			b.WriteString(line[:width])
			b.WriteByte('\n')
			line = line[width:]
		}
		b.WriteString(line)
	}
	return b.String()
}
