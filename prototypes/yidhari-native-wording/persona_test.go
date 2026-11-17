package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersonaFormats(t *testing.T) {
	for _, tc := range []struct{ format, body string }{
		{"openai", `{"messages":[{"role":"system","content":"Harness"},{"role":"user","content":"Copilot user"}],"n":1e3}`},
		{"openai-response", `{"instructions":"Harness","input":"user","n":1e3}`},
		{"claude", `{"system":[{"type":"text","text":"Harness"}],"messages":[],"n":1e3}`},
		{"gemini", `{"systemInstruction":{"parts":[{"text":"Harness"}]},"contents":[],"n":1e3}`},
		{"gemini", `{"system_instruction":{"parts":[{"text":"Harness"}]},"contents":[],"n":1e3}`},
		{"openai", `{"messages":[{"role":"user","content":"Copilot user"}]}`},
		{"openai-response", `{"input":"user"}`},
		{"claude", `{"messages":[]}`},
		{"gemini", `{"contents":[]}`},
	} {
		t.Run(tc.format+tc.body[:10], func(t *testing.T) {
			out, changed := injectPersona([]byte(tc.body), "Name: Copilot\nExact text", tc.format)
			if !changed || !strings.Contains(string(out), "Name: Copilot") {
				t.Fatal(string(out))
			}
			again, changed := injectPersona(out, "Name: Copilot\nExact text", tc.format)
			if changed || string(again) != string(out) {
				t.Fatal("not idempotent")
			}
			updated, _ := injectPersona(out, "New persona", tc.format)
			if strings.Contains(string(updated), "Exact text") || strings.Count(string(updated), "yidhari-persona:start") != 1 {
				t.Fatal(string(updated))
			}
			rewritten, _ := rewriteWith(out, compileRules(map[string]string{"Copilot": "yidhari"}))
			if !strings.Contains(string(rewritten), "Name: Copilot") {
				t.Fatal("persona was modified")
			}
			if strings.Contains(tc.body, "Copilot user") && !strings.Contains(string(rewritten), "Copilot user") {
				t.Fatal("user modified")
			}
			if strings.Contains(tc.body, "1e3") && !strings.Contains(string(out), "1e3") {
				t.Fatal("number spelling changed")
			}
		})
	}
	for _, body := range []string{`bad`, `null`, `{}`, `{"messages":"bad"}`, `{"system":7}`} {
		out, changed := injectPersona([]byte(body), "persona", "")
		if changed || string(out) != body {
			t.Fatal("unknown/malformed changed", body)
		}
	}
}

func TestPersonaBodyShapeWinsOverSourceHint(t *testing.T) {
	out, _ := injectPersona([]byte(`{"messages":[{"role":"user","content":"hello"}]}`), "persona", "gemini")
	if strings.Contains(string(out), "systemInstruction") || !strings.Contains(string(out), `"role":"system"`) {
		t.Fatal("wrong protocol field", string(out))
	}
}

func TestPersonaLoadingAndAtomicReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persona.md")
	if err := os.WriteFile(path, []byte("Exact persona\n"), 0600); err != nil {
		t.Fatal(err)
	}
	configure := func(path string) error {
		raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("persona-file: " + path + "\n")})
		_, err := handleMethod("plugin.reconfigure", raw)
		return err
	}
	if err := configure(path); err != nil {
		t.Fatal(err)
	}
	good := current.Load()
	if good.persona != "Exact persona\n" {
		t.Fatal("not verbatim")
	}
	for _, content := range [][]byte{nil, {0xff}, []byte(strings.Repeat("x", 65537)), []byte("<!-- yidhari-persona:start -->")} {
		os.WriteFile(path, content, 0600)
		if configure(path) == nil || current.Load() != good {
			t.Fatal("bad reload replaced config")
		}
	}
	if configure(filepath.Join(dir, "missing")) == nil || current.Load() != good {
		t.Fatal("missing file")
	}
	if configure("relative.md") == nil {
		t.Fatal("relative path accepted")
	}
	if err := configure(""); err != nil || current.Load().persona != "" {
		t.Fatal("disable failed")
	}
	current.Store(nil)
}
