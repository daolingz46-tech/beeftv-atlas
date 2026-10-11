package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type mcpRuntimeDescriptor struct {
	DesktopRuntimeConfig
	PID int `json:"pid"`
}

// The launch token stays in a private local session file, never MCP tool output.
func writeMCPRuntime(dataDir string, config DesktopRuntimeConfig) error {
	file, err := os.CreateTemp(dataDir, ".mcp-runtime-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err := secureMCPRuntime(name); err != nil {
		file.Close()
		return err
	}
	err = json.NewEncoder(file).Encode(mcpRuntimeDescriptor{DesktopRuntimeConfig: config, PID: os.Getpid()})
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, filepath.Join(dataDir, "mcp-runtime.json"))
}

func removeMCPRuntime(dataDir string) {
	path := filepath.Join(dataDir, "mcp-runtime.json")
	body, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var descriptor mcpRuntimeDescriptor
	if json.Unmarshal(body, &descriptor) == nil && descriptor.PID == os.Getpid() {
		_ = os.Remove(path)
	}
}
