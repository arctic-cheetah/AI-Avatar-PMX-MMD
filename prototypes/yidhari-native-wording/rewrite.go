package main

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type replacer struct {
	pattern *regexp.Regexp
	values  map[string]string
	whole   map[string]bool
}

func compileAll(rules, words map[string]string) *replacer {
	values := make(map[string]string)
	whole := make(map[string]bool)
	merge := func(source map[string]string, word bool) {
		keys := make([]string, 0, len(source))
		for key := range source {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if strings.TrimSpace(key) == "" {
				continue
			}
			lower := strings.ToLower(key)
			values[lower], whole[lower] = source[key], word
		}
	}
	merge(words, true)
	merge(rules, false)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) != len(keys[j]) {
			return len(keys[i]) > len(keys[j])
		}
		return keys[i] < keys[j]
	})
	escaped := make([]string, 0, len(keys))
	for _, key := range keys {
		escaped = append(escaped, regexp.QuoteMeta(key))
	}
	if len(escaped) == 0 {
		return &replacer{}
	}
	return &replacer{pattern: regexp.MustCompile("(?i:" + strings.Join(escaped, "|") + ")"), values: values, whole: whole}
}

func compileRules(rules map[string]string) *replacer {
	return compileAll(rules, nil)
}

func nameRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsMark(r) || r == '_' || r == '-'
}

func (r *replacer) replaceText(text string) (string, int) {
	var out strings.Builder
	last, count := 0, 0
	for _, span := range r.pattern.FindAllStringIndex(text, -1) {
		start, end := span[0], span[1]
		match := text[start:end]
		key := strings.ToLower(match)
		replacement, ok := r.values[key]
		if !ok {
			for candidate, value := range r.values {
				if strings.EqualFold(candidate, match) {
					key, replacement, ok = candidate, value, true
					break
				}
			}
		}
		if !ok {
			continue
		}
		if r.whole[key] {
			before, _ := utf8.DecodeLastRuneInString(text[:start])
			after, _ := utf8.DecodeRuneInString(text[end:])
			if (start > 0 && nameRune(before)) || (end < len(text) && nameRune(after)) {
				continue
			}
		}
		out.WriteString(text[last:start])
		out.WriteString(replacement)
		last, count = end, count+1
	}
	if count == 0 {
		return text, 0
	}
	out.WriteString(text[last:])
	return out.String(), count
}
func rewriteBody(body []byte, rules map[string]string) ([]byte, int) {
	return rewriteWith(body, compileRules(rules))
}
func rewriteWith(body []byte, r *replacer) ([]byte, int) {
	if r == nil || r.pattern == nil || len(body) > 16*1024*1024 {
		return body, 0
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil || root == nil {
		return body, 0
	}
	count := 0
	transformText := func(raw json.RawMessage) json.RawMessage {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return raw
		}
		changed, n := r.replaceText(text)
		if n == 0 {
			return raw
		}
		count += n
		result, _ := json.Marshal(changed)
		return result
	}
	transformBlocks := func(raw json.RawMessage, gemini bool) json.RawMessage {
		if len(raw) == 0 {
			return raw
		}
		if raw[0] == '"' {
			return transformText(raw)
		}
		var blocks []json.RawMessage
		if json.Unmarshal(raw, &blocks) != nil {
			return raw
		}
		start := count
		for i, block := range blocks {
			var item map[string]json.RawMessage
			if json.Unmarshal(block, &item) != nil || item == nil {
				continue
			}
			var kind string
			_ = json.Unmarshal(item["type"], &kind)
			if !gemini && kind != "text" && kind != "input_text" {
				continue
			}
			before := count
			item["text"] = transformText(item["text"])
			if count != before {
				blocks[i], _ = json.Marshal(item)
			}
		}
		if count == start {
			return raw
		}
		result, _ := json.Marshal(blocks)
		return result
	}
	for _, key := range []string{"system", "instructions"} {
		if raw, ok := root[key]; ok {
			root[key] = transformBlocks(raw, false)
		}
	}
	for _, key := range []string{"messages", "input"} {
		var messages []json.RawMessage
		if json.Unmarshal(root[key], &messages) != nil {
			continue
		}
		start := count
		for i, raw := range messages {
			var message map[string]json.RawMessage
			if json.Unmarshal(raw, &message) != nil || message == nil {
				continue
			}
			var role string
			_ = json.Unmarshal(message["role"], &role)
			if role != "system" && role != "developer" {
				continue
			}
			before := count
			message["content"] = transformBlocks(message["content"], false)
			if count != before {
				messages[i], _ = json.Marshal(message)
			}
		}
		if count != start {
			root[key], _ = json.Marshal(messages)
		}
	}
	for _, key := range []string{"systemInstruction", "system_instruction"} {
		var system map[string]json.RawMessage
		if json.Unmarshal(root[key], &system) != nil || system == nil {
			continue
		}
		before := count
		system["parts"] = transformBlocks(system["parts"], true)
		if count != before {
			root[key], _ = json.Marshal(system)
		}
	}
	if count == 0 {
		return body, 0
	}
	result, err := json.Marshal(root)
	if err != nil {
		return body, 0
	}
	return result, count
}
