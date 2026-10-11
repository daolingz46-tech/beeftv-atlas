package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMCPRuntimeDiscoveryRotatesAndCleansUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-runtime.json")
	for _, token := range []string{"test-first", "test-second"} {
		if err := writeMCPRuntime(dir, DesktopRuntimeConfig{BaseURL: "http://127.0.0.1:1234/api", LaunchToken: token}); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var descriptor mcpRuntimeDescriptor
		if err := json.Unmarshal(body, &descriptor); err != nil {
			t.Fatal(err)
		}
		if descriptor.LaunchToken != token || descriptor.PID != os.Getpid() {
			t.Fatal("descriptor did not rotate")
		}
	}
	removeMCPRuntime(dir)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("session file survived shutdown")
	}
}
