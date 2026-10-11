package main

import (
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
