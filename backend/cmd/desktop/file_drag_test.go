package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareNodeDragFilesMixedSelection(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.copyOwnedMedia = func(id, path string) error {
		if id != "owned-video" && id != "owned-image" {
			return errors.New("not owned")
		}
		return os.WriteFile(path, []byte(id), 0600)
	}
	text := "口播草案\n第二行"
	files := []NodeDragFile{{FileName: "../图片.png", ResourceID: "owned-image"}, {FileName: "视频.mp4", ResourceID: "owned-video"}, {FileName: "剧本.txt", Text: &text}, {FileName: "图片.png", ResourceID: "owned-image"}}
	paths, err := app.prepareNodeDragFiles(files)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 4 || paths[0] == paths[3] {
		t.Fatal("mixed selection lost")
	}
	for index, path := range paths {
		if !filepath.IsAbs(path) || !strings.HasPrefix(path, filepath.Join(app.dataDir, "exports", "drag")+string(os.PathSeparator)) {
			t.Fatal("unsafe staging path")
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != []string{"owned-image", "owned-video", text, "owned-image"}[index] {
			t.Fatal("payload changed")
		}
	}
	if _, err := app.prepareNodeDragFiles([]NodeDragFile{{FileName: "a", ResourceID: "owned-video"}, {FileName: "b", ResourceID: "foreign"}}); err == nil {
		t.Fatal("partial or unowned transfer accepted")
	}
	for _, batch := range [][]NodeDragFile{nil, {{FileName: "empty"}}, {{ResourceID: "owned-image", Text: &text}}} {
		if _, err := app.prepareNodeDragFiles(batch); err == nil {
			t.Fatal("invalid payload accepted")
		}
	}
}
