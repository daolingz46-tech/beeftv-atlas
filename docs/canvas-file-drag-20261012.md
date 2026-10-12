# 节点拖出 Windows 窗口

将窗口还原到较小尺寸，直接按住图片、视频或音频的内容区域，拖到桌面、资源管理器文件夹或支持文件拖入的软件后松开。媒体画面移动超过阈值后即进入系统文件拖拽，原节点不移动。节点标题仍用于窗口内移动，并保留跨出窗口导出的方式。框选后拖动其中一个节点会导出整个选区；Alt 保留原有画布内拖拽复制用途。播放按钮、标注、遮罩、图片或视频裁剪模式保留原有操作。

媒体使用当前节点的 owned resource，不使用预览视频代替原视频，也不把 blob URL 或资源链接伪装成文件。文字导出 `.txt`，Markdown、HTML、SVG 保持对应扩展名。其他结构节点导出 JSON，并过滤 API Key、Token、密码和鉴权 Header 等字段。JSON 是节点数据，不保证外部软件具有对应的渲染能力；画板节点的数据引用不等于完整笔画工程导出。

## 交接与保护

- 普通点击只启动轻量鼠标监视，不复制大媒体。媒体内容区拖动超过 6 个像素才准备文件；标题拖动等到鼠标移出窗口或进入覆盖在窗口上的其他程序时才准备文件。浏览器及非 Windows 客户端保持原有画布移动操作。
- Windows 独立锁定线程通过 `OleInitialize` 建立 STA；Shell IDataObject 提供 Unicode CF_HDROP，独立 IDropSource 读取物理按键状态，避免 Wails 回调线程使用旧按键状态而立即取消。实现依据见 [SHDoDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shdodragdrop)、[QueryContinueDrag](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nf-oleidl-idropsource-querycontinuedrag) 与 [GetKeyState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getkeystate)。
- 原节点只有 DOM 临时预览；交接时取消预览，不提交位置、分组或历史变更。手势序号阻止旧交接事件取消新的拖动。
- 原媒体经现有 `CopyOwnedResourceTo` 归属和文件边界校验。客户端不能提交本机源路径；所有副本准备完成后才进入 OLE 拖拽，任意失败不交付半个选区。
- 只允许 COPY，Shift 也不能移动原素材。Esc、过期手势、松开在本软件上都会取消。无需修改系统剪贴板。
- 为兼容延迟读取的编辑软件，副本保留在应用数据目录的 `exports/drag/selection-*`。目标软件完成导入后可清理这些副本；不会自动删除刚交付的文件。大型视频准备副本期间需要继续按住鼠标，提前松开会取消。

## 验证

专项 Go 测试验证混合选区、资源归属失败、路径清洗、重复文件名、Unicode CF_HDROP，以及 Esc / 过期手势的取消合同。浏览器测试验证窗口内移动、批量选区、交接恢复原节点和父节点、Alt 复制、失焦取消。TypeScript 检查通过。

另以独立临时素材执行真实 Windows OLE 交接：测试源窗口持有鼠标捕获，按住鼠标跨出窗口，目标 WinForms 程序及资源管理器文件夹分别接收图片、视频、文本三份文件，接收后哈希与源文件一致，源文件全部保留。这些测试不使用用户画布、不调用生成模型、不发送聊天消息；未逐一验证微信或各剪辑软件的文件接收行为。

直接拖媒体画面的新增验证：15 项前端专项测试通过，包括画面直接交接而不移动节点、标题窗口边界交接、播放按钮不启动文件拖动、Alt 仍复制、扩展名不重复。Windows 原生测试分别验证直接交接和窗口边界交接，资源管理器文件夹均接收图片、MP4、文本三份文件并逐一校验哈希。测试驱动显式激活接收窗口并使用实际窗口中心，避免鼠标落入遮挡它的终端窗口；系统返回成功本身不作为文件交付成功的依据。
