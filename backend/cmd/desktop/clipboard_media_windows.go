package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func copyFileToClipboard(path string) error {
	return copyFilesToClipboard([]string{path})
}

func copyFilesToClipboard(paths []string) error {
	if len(paths) == 0 {
		return errors.New("没有可复制的文件")
	}
	encoded, err := json.Marshal(paths)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Path is passed as an environment value, never interpolated into shell code.
	script := `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $files=New-Object System.Collections.Specialized.StringCollection; foreach ($path in (ConvertFrom-Json -InputObject $env:BEEFTV_CLIPBOARD_FILES)) { [void]$files.Add([string]$path) }; [System.Windows.Forms.Clipboard]::SetFileDropList($files)`
	command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	command.Env = append(os.Environ(), "BEEFTV_CLIPBOARD_FILES="+string(encoded))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := command.Run(); err != nil {
		return errors.New("文件复制失败，请稍后重试；剪贴板可能被其他程序占用")
	}
	return nil
}
