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
	return a.CopyOwnedMediaFiles([]string{fileName}, []string{resourceID})
}

func (a *DesktopApp) CopyOwnedMediaFiles(fileNames, resourceIDs []string) error {
	paths, err := a.prepareClipboardFiles(fileNames, resourceIDs)
	if err != nil {
		return err
	}
	return copyFilesToClipboard(paths)
}

// Prepare every owned file before replacing the clipboard, so a failed item
// cannot leave a misleading partial selection in another application.
func (a *DesktopApp) prepareClipboardFiles(fileNames, resourceIDs []string) ([]string, error) {
	if len(resourceIDs) == 0 || len(resourceIDs) != len(fileNames) || len(resourceIDs) > 1024 {
		return nil, fmt.Errorf("请选择 1 到 1024 个可用媒体文件")
	}
	paths := make([]string, 0, len(resourceIDs))
	for index, resourceID := range resourceIDs {
		name := fileNames[index]
		if len(resourceIDs) > 1 {
			name = fmt.Sprintf("%03d-%s", index+1, bootstrap.SanitizeSaveFileName(name))
		}
		path, err := a.prepareClipboardFile(name, resourceID)
		if err != nil {
			return nil, fmt.Errorf("第 %d 个文件复制失败: %w", index+1, err)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func (a *DesktopApp) prepareClipboardFile(fileName, resourceID string) (string, error) {
	if strings.TrimSpace(resourceID) == "" {
		return "", fmt.Errorf("没有可复制的本机文件")
	}
	directory := filepath.Join(a.dataDir, "clipboard", fmt.Sprintf("%x", sha256.Sum256([]byte(resourceID))))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", fmt.Errorf("无法准备复制文件")
	}
	path := filepath.Join(directory, bootstrap.SanitizeSaveFileName(fileName))
	if err := a.copyMedia(resourceID, path); err != nil {
		return "", err
	}
	return path, nil
}
