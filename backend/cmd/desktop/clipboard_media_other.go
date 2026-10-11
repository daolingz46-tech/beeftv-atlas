//go:build !windows

package main

import "errors"

func copyFileToClipboard(string) error {
	return errors.New("当前系统暂不支持直接复制媒体文件，请使用下载")
}
