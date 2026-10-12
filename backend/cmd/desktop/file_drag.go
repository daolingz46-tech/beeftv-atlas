package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"infinite-canvas/backend/internal/bootstrap"
)

type NodeDragFile struct {
	FileName   string  `json:"fileName"`
	ResourceID string  `json:"resourceId,omitempty"`
	Text       *string `json:"text,omitempty"`
}

type nodeFileDragSession struct {
	id      string
	cancel  context.CancelFunc
	started atomic.Bool
}

// Arm only observes the gesture. Files are prepared once the held pointer leaves
// the app window; normal clicks and canvas moves do not copy large media files.
func (a *DesktopApp) ArmNodeFileDrag(gestureID string, files []NodeDragFile) (string, error) {
	if len(gestureID) == 0 || len(gestureID) > 128 || len(files) == 0 || len(files) > 256 {
		return "", errors.New("请选择 1 到 256 个节点")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	session := &nodeFileDragSession{id: gestureID, cancel: cancel}
	a.fileDragMu.Lock()
	if a.fileDrag != nil {
		a.fileDragMu.Unlock()
		return "cancelled", nil
	}
	a.fileDrag = session
	a.fileDragMu.Unlock()
	defer func() {
		a.fileDragMu.Lock()
		if a.fileDrag == session {
			a.fileDrag = nil
		}
		a.fileDragMu.Unlock()
	}()
	return watchNativeFileDrag(ctx, func() ([]string, error) {
		session.started.Store(true)
		a.mu.RLock()
		wailsCtx := a.wailsCtx
		a.mu.RUnlock()
		if wailsCtx != nil {
			wailsruntime.EventsEmit(wailsCtx, "desktop:node-file-drag", gestureID)
		}
		return a.prepareNodeDragFiles(files)
	})
}

func (a *DesktopApp) CancelNodeFileDrag(gestureID string) {
	a.fileDragMu.Lock()
	defer a.fileDragMu.Unlock()
	if session := a.fileDrag; session != nil && session.id == gestureID && !session.started.Load() {
		session.cancel()
	}
}

func (a *DesktopApp) prepareNodeDragFiles(files []NodeDragFile) ([]string, error) {
	// Validate the entire batch before writing any payload. Never accept renderer
	// paths/URLs; media goes through the same ownership boundary as SaveOwnedMedia.
	textBytes := 0
	for _, file := range files {
		if (strings.TrimSpace(file.ResourceID) != "") == (file.Text != nil) {
			return nil, errors.New("部分节点没有可拖出的文件，请等待导入或生成完成")
		}
		if file.Text != nil {
			textBytes += len(*file.Text)
		}
	}
	if len(files) == 0 || len(files) > 256 || textBytes > 32<<20 {
		return nil, errors.New("拖出内容过多，请减少选中的节点")
	}
	directory := filepath.Join(a.dataDir, "exports", "drag")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, errors.New("无法准备拖出文件")
	}
	directory, err := os.MkdirTemp(directory, "selection-")
	if err != nil {
		return nil, errors.New("无法准备拖出文件")
	}
	paths := make([]string, 0, len(files))
	for index, file := range files {
		name := bootstrap.SanitizeSaveFileName(file.FileName)
		if len(files) > 1 {
			name = fmt.Sprintf("%03d-%s", index+1, name)
		}
		path := filepath.Join(directory, name)
		if file.Text != nil {
			err = os.WriteFile(path, []byte(*file.Text), 0600)
		} else {
			err = a.copyMedia(file.ResourceID, path)
		}
		if err != nil {
			// This directory was just created by us and cannot contain user files.
			_ = os.RemoveAll(directory)
			return nil, fmt.Errorf("第 %d 个节点无法拖出: %w", index+1, err)
		}
		paths = append(paths, path)
	}
	// Keep the exported copies: importers may open them after DoDragDrop returns.
	return paths, nil
}
