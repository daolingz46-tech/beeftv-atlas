//go:build !windows

package main

import (
	"context"
	"errors"
)

func watchNativeFileDrag(_ context.Context, _ bool, _ func() ([]string, error)) (string, error) {
	return "", errors.New("拖出节点文件目前需要 Windows 桌面客户端")
}
