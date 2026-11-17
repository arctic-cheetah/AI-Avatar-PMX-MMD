package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

var rules = map[string]string{
	"Keep your answers short and impersonal.":      "Keep your answers friendly and concise.",
	"an AI assistant using Copilot SDK in VS Code": "yidhari, an AI assistant in VS Code",
}

const instruction = "Keep your answers short and impersonal. You are an AI assistant using Copilot SDK in VS Code."

func TestFormats(t *testing.T) {
	for _, body := range []string{
		`{"messages":[{"role":"system","content":"` + instruction + `"}]}`,
		`{"messages":[{"role":"developer","content":[{"type":"text","text":"` + instruction + `"}]}]}`,
		`{"instructions":"` + instruction + `","input":"user"}`,
		`{"input":[{"role":"developer","content":[{"type":"input_text","text":"` + instruction + `"}]}]}`,
		`{"system":"` + instruction + `"}`,
		`{"system":[{"type":"text","text":"` + instruction + `","cache_control":{"type":"ephemeral"}}]}`,
		`{"systemInstruction":{"parts":[{"text":"` + instruction + `"}]}}`,
		`{"system_instruction":{"parts":[{"text":"` + instruction + `"}]}}`,
	} {
		t.Run(body[:15], func(t *testing.T) {
			result, n := rewriteBody([]byte(body), rules)
			if n != 2 || bytes.Contains(result, []byte("Copilot SDK")) || !json.Valid(result) {
				t.Fatalf("replacements=%d result=%s", n, result)
			}
			again, n := rewriteBody(result, rules)
			if n != 0 || !bytes.Equal(again, result) {
				t.Fatal("not idempotent")
			}
		})
	}
}
func TestPreservesNonInstructionData(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"` + instruction + `"},{"role":"assistant","content":"` + instruction + `"},{"role":"tool","content":"` + instruction + `"}],"tools":[{"description":"` + instruction + `"}],"metadata":{"system":"` + instruction + `"},"n":9007199254740993}`)
	result, n := rewriteBody(body, rules)
	if n != 0 || !bytes.Equal(body, result) {
		t.Fatal("non-instructions edited")
	}
	body = []byte(`{"system":"` + instruction + `","n":9007199254740993,"scientific":1e999,"tool":{"description":"Copilot SDK"}}`)
	result, n = rewriteBody(body, rules)
	if n != 2 || !bytes.Contains(result, []byte("9007199254740993")) || !bytes.Contains(result, []byte("1e999")) || !bytes.Contains(result, []byte(`"description":"Copilot SDK"`)) {
		t.Fatalf("data changed: %s", result)
	}
}
func TestUnknownPassThrough(t *testing.T) {
	for _, body := range []string{`{bad`, `[]`, `null`, `{"system":42}`, `{"system":[{"type":"image","text":"` + instruction + `"}]}`} {
		result, n := rewriteBody([]byte(body), rules)
		if n != 0 || string(result) != body {
			t.Fatal("unknown format edited")
		}
	}
}
func TestLongestNonCascadingLiteral(t *testing.T) {
	body := []byte(`{"system":"ABC abc ab"}`)
	result, n := rewriteBody(body, map[string]string{"abc": "ab", "ab": "x"})
	if n != 3 || !bytes.Contains(result, []byte(`"ab ab x"`)) {
		t.Fatalf("bad replacement: %s count=%d", result, n)
	}
}

func TestUnicodeCaseFoldDoesNotDeleteMatches(t *testing.T) {
	result, n := rewriteBody([]byte(`{"system":"ſhort"}`), map[string]string{"short": "concise"})
	if n != 1 || !bytes.Contains(result, []byte(`"concise"`)) {
		t.Fatalf("folding lost text: %s count=%d", result, n)
	}
}

func TestWholeNames(t *testing.T) {
	r := compileAll(nil, map[string]string{"Copilot": "yidhari", "github-copilot": "yidhari", "GitHub Copilot": "yidhari"})
	for _, tc := range []struct {
		before, after string
		count         int
	}{
		{"Copilot, COPILOT! github-copilot; GitHub Copilot.", "yidhari, yidhari! yidhari; yidhari.", 4},
		{"Copilot's name is (github-copilot).", "yidhari's name is (yidhari).", 2},
		{"copilot-cli my_copilot github-copilot-helper Copiloting api.githubcopilot.com", "copilot-cli my_copilot github-copilot-helper Copiloting api.githubcopilot.com", 0},
		{"éCopilot Copiloté Copilot\u0301", "éCopilot Copiloté Copilot\u0301", 0},
	} {
		body, _ := json.Marshal(map[string]string{"system": tc.before})
		result, n := rewriteWith(body, r)
		var decoded map[string]string
		_ = json.Unmarshal(result, &decoded)
		if n != tc.count || decoded["system"] != tc.after {
			t.Fatalf("got %q, count=%d", decoded["system"], n)
		}
	}
}

func TestWordRulesPreserveUserContentAndDoNotRescan(t *testing.T) {
	r := compileAll(map[string]string{"Your name is Copilot.": "Your name is yidhari."}, map[string]string{"Copilot": "github-copilot", "github-copilot": "yidhari"})
	body := []byte(`{"system":"Your name is Copilot. Copilot", "messages":[{"role":"user","content":"Copilot github-copilot"}]}`)
	result, n := rewriteWith(body, r)
	var decoded map[string]json.RawMessage
	_ = json.Unmarshal(result, &decoded)
	var system string
	_ = json.Unmarshal(decoded["system"], &system)
	if n != 2 || system != "Your name is yidhari. github-copilot" || !bytes.Contains(decoded["messages"], []byte("Copilot github-copilot")) {
		t.Fatalf("got %s count=%d", result, n)
	}
}
