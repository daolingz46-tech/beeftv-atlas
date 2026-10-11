//go:build !windows

package main

import "os"

func secureMCPRuntime(path string) error { return os.Chmod(path, 0600) }
