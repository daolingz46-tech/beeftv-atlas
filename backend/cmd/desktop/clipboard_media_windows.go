package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func copyFileToClipboard(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Path is passed as an environment value, never interpolated into shell code.
	script := `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $files=New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:BEEFTV_CLIPBOARD_FILE); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`
	command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	command.Env = append(os.Environ(), "BEEFTV_CLIPBOARD_FILE="+path)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := command.Run(); err != nil {
		return errors.New("文件复制失败，请稍后重试；剪贴板可能被其他程序占用")
	}
	return nil
}
