package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const personaStart = "<!-- yidhari-persona:start -->"
const personaEnd = "<!-- yidhari-persona:end -->"

var personaBlock = regexp.MustCompile(`\n\n<!-- yidhari-persona:start -->\n[\s\S]*?\n<!-- yidhari-persona:end -->`)

func loadPersona(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("persona-file must be absolute")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", errors.New("persona-file unavailable")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(b) > 65536 || !utf8.Valid(b) || strings.TrimSpace(string(b)) == "" || bytes.Contains(b, []byte(personaStart)) || bytes.Contains(b, []byte(personaEnd)) {
		return "", errors.New("invalid persona-file")
	}
	return string(b), nil
}

// Only instruction strings are visited. RawMessage retains unrelated JSON values.
func injectPersona(body []byte, persona, format string) ([]byte, bool) {
	if persona == "" || len(body) > 16*1024*1024 {
		return body, false
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil || root == nil {
		return body, false
	}
	marshal := func(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
	injected := false
	block := "\n\n" + personaStart + "\n" + persona + "\n" + personaEnd
	text := func(s string) string {
		s = personaBlock.ReplaceAllString(s, "")
		if !injected {
			s += block
			injected = true
		}
		return s
	}
	var content func(json.RawMessage, bool) (json.RawMessage, bool)
	content = func(raw json.RawMessage, gemini bool) (json.RawMessage, bool) {
		if len(raw) == 0 || string(raw) == "null" {
			return marshal(text("")), true
		}
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return marshal(text(s)), true
		}
		var parts []json.RawMessage
		if json.Unmarshal(raw, &parts) != nil {
			return raw, false
		}
		found := false
		for i, p := range parts {
			var obj map[string]json.RawMessage
			if json.Unmarshal(p, &obj) != nil || obj == nil {
				continue
			}
			var kind string
			json.Unmarshal(obj["type"], &kind)
			if !gemini && kind != "text" && kind != "input_text" {
				continue
			}
			if json.Unmarshal(obj["text"], &s) != nil {
				continue
			}
			obj["text"] = marshal(text(s))
			parts[i] = marshal(obj)
			found = true
		}
		if !found {
			obj := map[string]any{"text": text("")}
			if !gemini {
				obj["type"] = "text"
			}
			parts = append(parts, marshal(obj))
		}
		return marshal(parts), true
	}
	// Body shape wins over source hints, since hook phases may see translated JSON.
	switch {
	case root["systemInstruction"] != nil || root["system_instruction"] != nil || root["contents"] != nil:
		format = "gemini"
	case root["instructions"] != nil || root["input"] != nil:
		format = "openai-response"
	case root["system"] != nil:
		format = "claude"
	case root["messages"] != nil:
		// Missing Claude system fields need the original protocol hint.
		if format != "claude" && format != "anthropic" {
			format = "openai"
		}
	}
	switch {
	case root["systemInstruction"] != nil || root["system_instruction"] != nil || root["contents"] != nil || format == "gemini":
		key := "systemInstruction"
		if root["system_instruction"] != nil {
			key = "system_instruction"
		}
		obj := map[string]json.RawMessage{}
		if raw := root[key]; len(raw) > 0 && (json.Unmarshal(raw, &obj) != nil || obj == nil) {
			return body, false
		}
		raw := obj["parts"]
		if len(raw) == 0 {
			raw = json.RawMessage(`[]`)
		}
		parts, ok := content(raw, true)
		if !ok {
			return body, false
		}
		obj["parts"] = parts
		root[key] = marshal(obj)
	case root["instructions"] != nil || root["input"] != nil || format == "openai-response" || format == "responses":
		raw, ok := content(root["instructions"], false)
		if !ok {
			return body, false
		}
		root["instructions"] = raw
	case root["system"] != nil || format == "claude" || format == "anthropic":
		raw, ok := content(root["system"], false)
		if !ok {
			return body, false
		}
		root["system"] = raw
	case root["messages"] != nil || format == "openai":
		var messages []json.RawMessage
		if raw := root["messages"]; len(raw) > 0 && json.Unmarshal(raw, &messages) != nil {
			return body, false
		}
		for i, raw := range messages {
			var msg map[string]json.RawMessage
			if json.Unmarshal(raw, &msg) != nil || msg == nil {
				continue
			}
			var role string
			json.Unmarshal(msg["role"], &role)
			if role != "system" && role != "developer" {
				continue
			}
			updated, ok := content(msg["content"], false)
			if !ok {
				return body, false
			}
			msg["content"] = updated
			messages[i] = marshal(msg)
		}
		if !injected {
			messages = append([]json.RawMessage{marshal(map[string]any{"role": "system", "content": text("")})}, messages...)
		}
		root["messages"] = marshal(messages)
	default:
		return body, false
	}
	result := marshal(root)
	// Semantic whitespace may normalise once; subsequent hook passes are no-ops.
	if bytes.Equal(result, body) {
		return body, false
	}
	return result, true
}

func (r *replacer) replaceOutsidePersona(text string) (string, int) {
	spans := personaBlock.FindAllStringIndex(text, -1)
	if len(spans) == 0 {
		return r.replaceText(text)
	}
	var out strings.Builder
	last, total := 0, 0
	for _, s := range spans {
		part, n := r.replaceText(text[last:s[0]])
		out.WriteString(part)
		out.WriteString(text[s[0]:s[1]])
		total += n
		last = s[1]
	}
	part, n := r.replaceText(text[last:])
	out.WriteString(part)
	return out.String(), total + n
}
