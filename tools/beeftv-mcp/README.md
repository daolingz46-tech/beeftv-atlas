# BeefTV MCP

基于 [官方 MCP Python SDK](https://py.sdk.modelcontextprotocol.io/v1/) 的本地 stdio 服务。连接 BeefTV 桌面端的现有后端，复用生成、素材水合、费用预估和任务生命周期。不调用旧内置 Agent 的入口或调度器。

## 安装与接入

需要 Python 3.10+ 和包含 MCP 支持的 BeefTV 桌面版。运行：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

先打开 BeefTV。桌面程序自动写入只允许当前用户访问的 `mcp-runtime.json`（Windows 另允许 SYSTEM）；退出时删除，重启时轮换连接端口和令牌。MCP 每次调用重新读取连接信息，不需要复制 Atlas API Key。

通用 MCP 客户端配置如下；把 Python、server.py 和数据目录替换为本机绝对路径。Qoder、Cursor、Claude Desktop 等支持 `mcpServers` 的客户端可采用此结构。

```json
{
  "mcpServers": {
    "beeftv": {
      "command": "ABSOLUTE_PATH/.venv/Scripts/python.exe",
      "args": ["ABSOLUTE_PATH/server.py"],
      "env": {"BEEFTV_DATA_DIR": "ABSOLUTE_WORKSPACE_DATA_DIR", "PYTHONUTF8": "1"}
    }
  }
}
```

未指定 `BEEFTV_DATA_DIR` 时，使用系统用户配置目录下的 BeefTV。stdio 服务由 Agent 客户端按需启动；不需要单独开终端，不监听公共 MCP 网络端口。BeefTV 关闭时状态工具返回未连接，需先打开桌面程序。

## 工具

| 工具 | 功能 |
|---|---|
| `beeftv_status` | 检查桌面连接 |
| `beeftv_list_models` | 按类型、系列或关键词检索并分页 |
| `beeftv_model_details` | 能力、默认设置、参考限制、视频用途、音频音色 |
| `beeftv_estimate_cost` | 免费费用查询；不创建生成任务 |
| `beeftv_generate` | 提交异步任务，可设置估价预算上限 |
| `beeftv_get_task` | 状态及解析后的结果 |
| `beeftv_list_tasks` | 最近任务，排除私有输入正文 |
| `beeftv_wait_task` | 最长等待 50 秒；未完成时继续查询同一任务 |
| `beeftv_cancel_task` | 取消任务；不承诺退回已产生的供应商费用 |
| `beeftv_upload_file` | 上传本地参考素材并返回 `resource:ID` |
| `beeftv_download_result` | 下载已有资源到新的绝对路径，不覆盖现有文件 |

## Agent 调用顺序

1. `list_models(mode="image", search="Flare")`，复制完整 `model_id`。
2. `model_details(model_id)`，按能力选择支持的尺寸、画质、分辨率；视频使用支持的 operation。
3. 本地参考素材先 `upload_file`，把返回的 `storageKey` 放入 `reference_images` / `reference_videos` / `reference_audios`。远程参考可直接使用公共 http(s) URL；视频/音频费用查询需要真实时长元数据。
4. 对下面同一份 request 调用 `estimate_cost`，再调用 `generate`。生成可能收费；费用预估不是最终账单。
5. 保存 task ID，调用 `get_task` 或 `wait_task`。结果中的 `storageKey` 去掉 `resource:` 后，传给 `download_result` 的 `resource_id`。

```json
{
  "request": {
    "model_id": "atlascloud-image::openai/gpt-image-2.5-flare/text-to-image",
    "prompt": "竖屏海报，清晰的中文标题，简洁布局",
    "settings": {"size": "768x1024", "quality": "low"},
    "reference_images": [],
    "reference_videos": [],
    "reference_audios": []
  },
  "request_id": "poster-unique-request-001",
  "max_cost_usd": 0.10
}
```

具体参数以 `model_details` 为准；没有独立分辨率的模型不传 `imageResolution`，有独立分辨率时按能力枚举填写。模型列出的 available 只表示本地配置可调用，不代表供应商权限或余额已经检查。图片每个调用生成一张；需要多张时使用不同 request_id。

`request_id` 必填，同一 ID 只能对应同一组参数。去重记录保存在数据目录的独立 `mcp-requests.sqlite3`，不修改项目数据库。并发、重启或网络超时不会自动重复提交。提交结果不确定时，同一 ID 会拒绝再次提交；查询最近任务和 `get_task` 返回的 request_id，确认原任务后再决定后续动作。不要删除去重记录后盲目重试。

默认不修改 Agent 的全局配置。把接入配置加入需要使用它的客户端，再刷新该客户端的 MCP 连接。

## 验证

```powershell
.venv\Scripts\python.exe -m unittest -v test_bridge test_stdio
.venv\Scripts\python.exe smoke_readonly.py
```

单元及协议测试只使用合成配置/模拟接口。只读冒烟检查连接实际运行的桌面应用，不上传、不报价、不生成。测试覆盖参数一致性、去重、超时、预算拒绝、令牌轮换、秘密过滤、标准 SDK 握手和文件保存。
