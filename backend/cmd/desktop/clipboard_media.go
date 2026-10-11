package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/bootstrap"
)

// CopyOwnedMedia keeps a stable clipboard file alive after the app exits.
// Ownership and source-path validation remain in the existing save boundary.
func (a *DesktopApp) CopyOwnedMedia(fileName, resourceID string) error {
	if strings.TrimSpace(resourceID) == "" {
		return fmt.Errorf("没有可复制的本机文件")
	}
	directory := filepath.Join(a.dataDir, "clipboard", fmt.Sprintf("%x", sha256.Sum256([]byte(resourceID))))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return fmt.Errorf("无法准备复制文件")
	}
	path := filepath.Join(directory, bootstrap.SanitizeSaveFileName(fileName))
	if err := a.copyMedia(resourceID, path); err != nil {
		return err
	}
	return copyFileToClipboard(path)
}
