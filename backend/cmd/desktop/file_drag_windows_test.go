package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsDragDataObjectTransfersUnicodeFileList(t *testing.T) {
	directory := t.TempDir()
	paths := []string{filepath.Join(directory, "图片 有空格.png"), filepath.Join(directory, "视频'引号.mp4"), filepath.Join(directory, "剧本.txt")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	_, err := withDragDataObject(paths, func(object uintptr) (string, error) {
		format := dragFormat{Format: 15, Aspect: 1, Index: -1, Medium: 1}
		if hr := dragCOMCall(object, 5, uintptr(unsafe.Pointer(&format))); int32(hr) < 0 {
			t.Fatalf("CF_HDROP not advertised: %x", hr)
		}
		var medium dragMedium
		if hr := dragCOMCall(object, 3, uintptr(unsafe.Pointer(&format)), uintptr(unsafe.Pointer(&medium))); int32(hr) < 0 {
			t.Fatalf("CF_HDROP unavailable: %x", hr)
		}
		defer dragOLE.NewProc("ReleaseStgMedium").Call(uintptr(unsafe.Pointer(&medium)))
		count, _, _ := dragShell.NewProc("DragQueryFileW").Call(medium.Handle, 0xffffffff, 0, 0)
		if int(count) != len(paths) {
			t.Fatal("file count changed")
		}
		for index, path := range paths {
			buffer := make([]uint16, 32768)
			dragShell.NewProc("DragQueryFileW").Call(medium.Handle, uintptr(index), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
			if got := syscall.UTF16ToString(buffer); got != path {
				t.Fatalf("path changed: %q", got)
			}
		}
		return "checked", nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNativeDropSourceCancelsOnEscapeAndExpiredGesture(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	source := &nativeDropSource{Vtable: &nativeDropSourceVtable, ctx: ctx}
	source.refs.Store(1)
	if got := dragCOMCall(uintptr(unsafe.Pointer(source)), 3, 1, 1); got != 0x40101 {
		t.Fatal("Escape did not cancel")
	}
	cancel()
	if got := dragCOMCall(uintptr(unsafe.Pointer(source)), 3, 0, 1); got != 0x40101 {
		t.Fatal("expired gesture did not cancel")
	}
	runtime.KeepAlive(source)
}

func TestWindowsFileDragLive(t *testing.T) {
	if os.Getenv("BEEFTV_FILE_DRAG_TEST") != "1" {
		t.Skip("explicit synthetic native drop integration opt-in")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	paths := []string{os.Getenv("BEEFTV_FILE_DRAG_TEST_IMAGE"), os.Getenv("BEEFTV_FILE_DRAG_TEST_VIDEO"), os.Getenv("BEEFTV_FILE_DRAG_TEST_TEXT")}
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("synthetic file required")
		}
	}
	class, _ := syscall.UTF16PtrFromString("STATIC")
	title, _ := syscall.UTF16PtrFromString("BeefTV synthetic drag source")
	hwnd, _, _ := dragUser.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0x90000000, 40, 100, 300, 220, 0, 0, 0, 0)
	if hwnd == 0 {
		t.Fatal("test source window failed")
	}
	defer dragUser.NewProc("DestroyWindow").Call(hwnd)
	dragUser.NewProc("SetWindowPos").Call(hwnd, ^uintptr(0), 0, 0, 0, 0, 3) // keep synthetic source above the user's app
	dragUser.NewProc("SetForegroundWindow").Call(hwnd)
	if err := os.WriteFile(os.Getenv("BEEFTV_FILE_DRAG_TEST_READY"), []byte(fmt.Sprint(hwnd)), 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for !dragKeyDown(1) && time.Now().Before(deadline) {
		time.Sleep(8 * time.Millisecond)
	}
	// Model the capture held by WebView while dragging a canvas node.
	dragUser.NewProc("SetCapture").Call(hwnd)
	foreground, _, _ := dragUser.NewProc("GetForegroundWindow").Call()
	var foregroundPID uint32
	dragUser.NewProc("GetWindowThreadProcessId").Call(foreground, uintptr(unsafe.Pointer(&foregroundPID)))
	t.Logf("synthetic source=%x foreground=%x pid=%d self=%d button=%t", hwnd, foreground, foregroundPID, os.Getpid(), dragKeyDown(1))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	prepared := 0
	result, err := watchNativeFileDrag(ctx, func() ([]string, error) { prepared++; return paths, nil })
	if err != nil || result != "dropped" {
		t.Fatalf("native drop: %s, %v, preparations=%d", result, err, prepared)
	}
	if prepared != 1 {
		t.Fatal("gesture did not hand off exactly once")
	}
}
