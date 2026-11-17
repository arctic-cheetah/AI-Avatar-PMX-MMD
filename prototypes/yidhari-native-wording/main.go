package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef struct { uint32_t abi_version; void* host_ctx; void* call; void* free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"os"
	"sync/atomic"
	"unsafe"
)

type pluginConfig struct {
	Rules     map[string]string `yaml:"sensitive-words-replace"`
	WordRules map[string]string `yaml:"word-replacements"`
	LogCounts bool              `yaml:"log-counts"`
}
type settings struct {
	rewrite   *replacer
	logCounts bool
}

var current atomic.Pointer[settings]

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, api *C.cliproxy_plugin_api) C.int {
	if host == nil || api == nil || host.abi_version != 1 {
		return 1
	}
	api.abi_version = 1
	api.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	api.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	api.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, input *C.uint8_t, length C.size_t, output *C.cliproxy_buffer) C.int {
	if output == nil {
		return 1
	}
	output.ptr = nil
	output.len = 0
	if method == nil || length > 64*1024*1024 {
		return 1
	}
	var raw []byte
	if input != nil && length > 0 {
		raw = C.GoBytes(unsafe.Pointer(input), C.int(length))
	}
	result, err := handleMethod(C.GoString(method), raw)
	var envelope []byte
	if err != nil {
		envelope, _ = json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": "invalid_request", "message": "Yidhari wording plugin could not process the request"}})
	} else {
		envelope, _ = json.Marshal(map[string]any{"ok": true, "result": result})
	}
	output.ptr = C.CBytes(envelope)
	output.len = C.size_t(len(envelope))
	if err != nil {
		return 1
	}
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() { current.Store(nil) }

func handleMethod(method string, raw []byte) (any, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req struct {
			ConfigYAML []byte `json:"config_yaml"`
		}
		if len(raw) > 0 && json.Unmarshal(raw, &req) != nil {
			return nil, errors.New("invalid lifecycle")
		}
		var cfg pluginConfig
		if len(req.ConfigYAML) > 0 && yaml.Unmarshal(req.ConfigYAML, &cfg) != nil {
			return nil, errors.New("invalid configuration")
		}
		current.Store(&settings{compileAll(cfg.Rules, cfg.WordRules), cfg.LogCounts})
		return map[string]any{
			"schema_version": 10,
			"metadata": map[string]any{"Name": "yidhari-wording", "Version": "0.2.0", "Author": "AI-assisted", "GitHubRepository": "https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD", "ConfigFields": []map[string]string{
				{"Name": "sensitive-words-replace", "Type": "object", "Description": "Literal replacements in instruction fields, independent of provider"},
				{"Name": "word-replacements", "Type": "object", "Description": "Whole-name replacements in instruction fields; preserves longer hyphenated or underscored identifiers"},
				{"Name": "log-counts", "Type": "boolean", "Description": "Log replacement counts only; never prompt text"}}},
			"capabilities": map[string]bool{"request_interceptor": true},
		}, nil
	case "request.intercept_before", "request.intercept_after":
		var req struct{ Body []byte }
		if json.Unmarshal(raw, &req) != nil {
			return nil, errors.New("invalid request")
		}
		cfg := current.Load()
		if cfg == nil {
			return map[string]any{}, nil
		}
		body, n := rewriteWith(req.Body, cfg.rewrite)
		if n == 0 {
			return map[string]any{}, nil
		}
		if cfg.logCounts {
			fmt.Fprintf(os.Stderr, "Yidhari wording: replacements=%d\n", n)
		}
		return struct{ Body []byte }{body}, nil
	default:
		return nil, errors.New("unsupported method")
	}
}
