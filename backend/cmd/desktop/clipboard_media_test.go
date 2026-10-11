package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCopyOwnedMediaStopsBeforeClipboardWhenResourceIsUnavailable(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	sentinel := errors.New("synthetic missing owned resource")
	app.copyOwnedMedia = func(id, path string) error {
		if id != "synthetic-id" {
			t.Fatal("resource ID changed")
		}
		if filepath.Base(path) != "clip.mp4" || !filepath.IsAbs(path) {
			t.Fatal("unsafe clipboard destination")
		}
		return sentinel
	}
	if err := app.CopyOwnedMedia("../clip.mp4", "synthetic-id"); !errors.Is(err, sentinel) {
		t.Fatalf("ownership error lost: %v", err)
	}
	if err := app.CopyOwnedMedia("clip.mp4", ""); err == nil {
		t.Fatal("empty resource ID accepted")
	}
}

func TestFileClipboardLive(t *testing.T) {
	if os.Getenv("BEEFTV_CLIPBOARD_TEST") != "1" {
		t.Skip("explicit clipboard integration opt-in")
	}
	path := os.Getenv("BEEFTV_CLIPBOARD_TEST_FILE")
	if path == "" {
		t.Fatal("synthetic fixture required")
	}
	if err := copyFileToClipboard(path); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareClipboardFilesPreservesMixedSelectionAndDuplicateResources(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.copyOwnedMedia = func(id, path string) error {
		if id != "image" && id != "video" {
			return errors.New("not owned")
		}
		return os.WriteFile(path, []byte(id), 0600)
	}
	paths, err := app.prepareClipboardFiles([]string{"../图片.png", "视频.mp4", "图片.png"}, []string{"image", "video", "image"})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 3 || paths[0] == paths[2] {
		t.Fatalf("selection lost: %v", paths)
	}
	for i, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != []string{"image", "video", "image"}[i] {
			t.Fatalf("file %d changed", i)
		}
		if !filepath.IsAbs(path) {
			t.Fatal("relative clipboard path")
		}
	}
	if _, err := app.prepareClipboardFiles([]string{"a", "b"}, []string{"image", "not-owned"}); err == nil {
		t.Fatal("partial selection accepted")
	}
	if _, err := app.prepareClipboardFiles([]string{"a"}, nil); err == nil {
		t.Fatal("invalid arrays accepted")
	}
}

func TestBatchFileClipboardLive(t *testing.T) {
	if os.Getenv("BEEFTV_CLIPBOARD_TEST") != "1" {
		t.Skip("explicit clipboard integration opt-in")
	}
	var paths []string
	if err := json.Unmarshal([]byte(os.Getenv("BEEFTV_CLIPBOARD_TEST_FILES")), &paths); err != nil || len(paths) != 11 {
		t.Fatal("eleven synthetic fixtures required")
	}
	if err := copyFilesToClipboard(paths); err != nil {
		t.Fatal(err)
	}
}
