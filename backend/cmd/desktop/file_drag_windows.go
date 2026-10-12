package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	dragShell         = windows.NewLazySystemDLL("shell32.dll")
	dragOLE           = windows.NewLazySystemDLL("ole32.dll")
	dragUser          = windows.NewLazySystemDLL("user32.dll")
	dragKernel        = windows.NewLazySystemDLL("kernel32.dll")
	iidDragDataObject = windows.GUID{Data1: 0x10e, Data4: [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidDragUnknown    = windows.GUID{Data4: [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidDragSource     = windows.GUID{Data1: 0x121, Data4: [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
)

type nativeDropSource struct {
	Vtable *[5]uintptr
	refs   atomic.Int32
	ctx    context.Context
}

// The gesture begins on WebView's UI thread, but Wails bindings run on another
// thread. Shell's default source reads that thread's stale keyboard state and
// cancels immediately. Our source observes the physical button instead.
var nativeDropSourceVtable = [5]uintptr{
	syscall.NewCallback(func(this, iid, out uintptr) uintptr {
		if out == 0 {
			return 0x80004003
		}
		*(*uintptr)(unsafe.Pointer(out)) = 0
		if iid == 0 {
			return 0x80004002
		}
		value := *(*windows.GUID)(unsafe.Pointer(iid))
		if value != iidDragUnknown && value != iidDragSource {
			return 0x80004002
		}
		*(*uintptr)(unsafe.Pointer(out)) = this
		(*nativeDropSource)(unsafe.Pointer(this)).refs.Add(1)
		return 0
	}),
	syscall.NewCallback(func(this uintptr) uintptr { return uintptr((*nativeDropSource)(unsafe.Pointer(this)).refs.Add(1)) }),
	syscall.NewCallback(func(this uintptr) uintptr { return uintptr((*nativeDropSource)(unsafe.Pointer(this)).refs.Add(-1)) }),
	syscall.NewCallback(func(this, escapePressed, _ uintptr) uintptr {
		source := (*nativeDropSource)(unsafe.Pointer(this))
		if escapePressed != 0 || dragKeyDown(0x1b) || source.ctx.Err() != nil {
			return 0x40101
		}
		if !dragKeyDown(1) {
			var point dragPoint
			dragUser.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
			if dragPointOwnedByProcess(point) {
				return 0x40101
			}
			return 0x40100
		}
		return 0
	}),
	syscall.NewCallback(func(_, _ uintptr) uintptr { return 0x40102 }), // DRAGDROP_S_USEDEFAULTCURSORS
}

type dragPoint struct{ X, Y int32 }
type dragRect struct{ Left, Top, Right, Bottom int32 }
type dragFormat struct {
	Format uint16
	Target uintptr
	Aspect uint32
	Index  int32
	Medium uint32
}
type dragMedium struct {
	Medium  uint32
	Handle  uintptr
	Release uintptr
}

type dragThreadInfo struct {
	Size, Flags                                        uint32
	Active, Focus, Capture, MenuOwner, MoveSize, Caret uintptr
	CaretRect                                          dragRect
}

func dragKeyDown(key uintptr) bool {
	value, _, _ := dragUser.NewProc("GetAsyncKeyState").Call(key)
	return value&0x8000 != 0
}

func dragPointOwnedByProcess(point dragPoint) bool {
	var hit uintptr
	if unsafe.Sizeof(uintptr(0)) == 8 {
		hit, _, _ = dragUser.NewProc("WindowFromPoint").Call(uintptr(uint64(uint32(point.X)) | uint64(uint32(point.Y))<<32))
	} else {
		hit, _, _ = dragUser.NewProc("WindowFromPoint").Call(uintptr(uint32(point.X)), uintptr(uint32(point.Y)))
	}
	root, _, _ := dragUser.NewProc("GetAncestor").Call(hit, 2) // GA_ROOT includes hosted WebView children
	var pid uint32
	dragUser.NewProc("GetWindowThreadProcessId").Call(root, uintptr(unsafe.Pointer(&pid)))
	return pid == uint32(os.Getpid())
}

func watchNativeFileDrag(ctx context.Context, immediate bool, prepare func() ([]string, error)) (string, error) {
	// COM objects and the OLE message loop must remain on one initialized STA.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hwnd, _, _ := dragUser.NewProc("GetForegroundWindow").Call()
	var pid uint32
	uiThread, _, _ := dragUser.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != uint32(os.Getpid()) || !dragKeyDown(1) {
		return "cancelled", nil
	}
	var start dragPoint
	dragUser.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&start)))
	ticker := time.NewTicker(8 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return "cancelled", nil
		case <-ticker.C:
			if !dragKeyDown(1) || dragKeyDown(0x1b) {
				return "cancelled", nil
			}
			var point dragPoint
			var rect dragRect
			ok, _, _ := dragUser.NewProc("GetWindowRect").Call(hwnd, uintptr(unsafe.Pointer(&rect)))
			if ok == 0 {
				return "cancelled", nil
			}
			dragUser.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
			if absDrag(point.X-start.X) < 6 && absDrag(point.Y-start.Y) < 6 {
				continue
			}
			if !immediate && point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom && dragPointOwnedByProcess(point) {
				continue
			}
			// Cancel WebView capture on its UI thread before handing pointer tracking
			// to OLE. This does not end the physical held-button gesture.
			paths, err := prepare()
			if err != nil {
				return "", err
			}
			if !dragKeyDown(1) || dragKeyDown(0x1b) || ctx.Err() != nil {
				return "cancelled", nil
			}
			info := dragThreadInfo{Size: uint32(unsafe.Sizeof(dragThreadInfo{}))}
			dragUser.NewProc("GetGUIThreadInfo").Call(uiThread, uintptr(unsafe.Pointer(&info)))
			if info.Capture != 0 {
				dragUser.NewProc("SendMessageW").Call(info.Capture, 0x001f, 0, 0)
			} // WM_CANCELMODE on capture's UI thread
			return dragNativeFiles(ctx, paths)
		}
	}
}

func absDrag(value int32) int32 {
	if value < 0 {
		return -value
	}
	return value
}

func withDragDataObject(paths []string, use func(uintptr) (string, error)) (string, error) {
	hr, _, _ := dragOLE.NewProc("OleInitialize").Call(0)
	if int32(hr) < 0 {
		return "", errors.New("无法初始化 Windows 文件拖拽")
	}
	defer dragOLE.NewProc("OleUninitialize").Call()
	var object uintptr
	hr, _, _ = dragShell.NewProc("SHCreateDataObject").Call(0, 0, 0, 0, uintptr(unsafe.Pointer(&iidDragDataObject)), uintptr(unsafe.Pointer(&object)))
	if int32(hr) < 0 || object == 0 {
		return "", errors.New("无法创建 Windows 文件拖拽对象")
	}
	defer dragCOMCall(object, 2)
	if err := setDragFileDrop(object, paths); err != nil {
		return "", err
	}
	return use(object)
}

func dragNativeFiles(ctx context.Context, paths []string) (string, error) {
	return withDragDataObject(paths, func(object uintptr) (string, error) {
		source := &nativeDropSource{Vtable: &nativeDropSourceVtable, ctx: ctx}
		source.refs.Store(1)
		var effect uint32
		// COPY only: dropping into Explorer or an editor must never move/delete
		// an owned source file, even when the user holds Shift.
		hr, _, _ := dragShell.NewProc("SHDoDragDrop").Call(0, object, uintptr(unsafe.Pointer(source)), 1, uintptr(unsafe.Pointer(&effect)))
		runtime.KeepAlive(source)
		if uint32(hr) == 0x40100 && effect&1 != 0 {
			return "dropped", nil
		}
		if uint32(hr) == 0x40101 || int32(hr) >= 0 && effect == 0 {
			return "cancelled", nil
		}
		return "", fmt.Errorf("Windows 文件拖拽未完成（%08x）", uint32(hr))
	})
}

func dragCOMCall(object uintptr, index int, args ...uintptr) uintptr {
	vtable := *(*uintptr)(unsafe.Pointer(object))
	method := *(*uintptr)(unsafe.Pointer(vtable + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	result, _, _ := syscall.SyscallN(method, append([]uintptr{object}, args...)...)
	return result
}

func setDragFileDrop(object uintptr, paths []string) error {
	if len(paths) == 0 {
		return errors.New("没有可拖出的文件")
	}
	// DROPFILES has a 20-byte header and a double-NUL terminated UTF-16 list.
	list := make([]uint16, 0)
	for _, path := range paths {
		list = append(list, utf16.Encode([]rune(path))...)
		list = append(list, 0)
	}
	list = append(list, 0)
	size := 20 + len(list)*2
	handle, _, _ := dragKernel.NewProc("GlobalAlloc").Call(2, uintptr(size)) // GMEM_MOVEABLE
	if handle == 0 {
		return errors.New("无法准备拖出文件列表")
	}
	ptr, _, _ := dragKernel.NewProc("GlobalLock").Call(handle)
	if ptr == 0 {
		dragKernel.NewProc("GlobalFree").Call(handle)
		return errors.New("无法准备拖出文件列表")
	}
	data := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), size)
	clear(data)
	binary.LittleEndian.PutUint32(data[0:], 20)
	binary.LittleEndian.PutUint32(data[16:], 1) // fWide
	for index, value := range list {
		binary.LittleEndian.PutUint16(data[20+index*2:], value)
	}
	dragKernel.NewProc("GlobalUnlock").Call(handle)
	format := dragFormat{Format: 15, Aspect: 1, Index: -1, Medium: 1} // CF_HDROP, DVASPECT_CONTENT, TYMED_HGLOBAL
	medium := dragMedium{Medium: 1, Handle: handle}
	hr := dragCOMCall(object, 7, uintptr(unsafe.Pointer(&format)), uintptr(unsafe.Pointer(&medium)), 1)
	if int32(hr) < 0 {
		dragKernel.NewProc("GlobalFree").Call(handle)
		return errors.New("无法传递拖出文件列表")
	}
	return nil // IDataObject owns HGLOBAL after successful SetData(fRelease=TRUE).
}
