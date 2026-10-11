"""Run with a local MCP client over stdio. Never print to stdout."""
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from core import Bridge, GenerationRequest, SETTING_NAMES

bridge = Bridge()
mcp = FastMCP('BeefTV', instructions='Local BeefTV generation tools. Copy model IDs from list_models; inspect model_details and estimate_cost before generation. Upload local references first. Generation may incur provider charges. Reuse request_id only with identical arguments. Poll get_task/wait_task, then download stored resource results. Do not expose provider secrets. BeefTV desktop must be running.')
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)


@mcp.tool(annotations=READ)
async def beeftv_status() -> dict[str, Any]:
    """Check whether the local desktop backend is reachable; returns no tokens."""
    try:
        await bridge.api('GET', '/health')
        return {'running': True}
    except RuntimeError as error:
        return {'running': False, 'message': str(error)}


@mcp.tool(annotations=READ)
async def beeftv_list_models(mode: str = '', search: str = '', family: str = '', available_only: bool = True, offset: int = 0, limit: int = 30) -> dict[str, Any]:
    """Search configured text/image/video/audio models by name or series, with pagination."""
    items = [info for _, _, info in await bridge.catalog() if (not mode or info['mode'] == mode) and (not available_only or info['available']) and (not family or family.casefold() in info['family'].casefold()) and search.casefold() in (info['model_id'] + ' ' + info['name'] + ' ' + info['family']).casefold()]
    offset, limit = max(0, offset), max(1, min(100, limit))
    return {'total': len(items), 'offset': offset, 'models': items[offset:offset + limit], 'next_offset': offset + limit if offset + limit < len(items) else None}


@mcp.tool(annotations=READ)
async def beeftv_model_details(model_id: str) -> dict[str, Any]:
    """Read model capabilities, reference limits, operations and default parameters."""
    _, profile, info = await bridge.model(model_id)
    result = dict(info, capabilities=profile.get('capabilityConfig', {}), defaults=bridge.defaults(profile), setting_names=sorted(SETTING_NAMES))
    audio_file = Path(__file__).with_name('atlas-audio-profiles.json')
    if not audio_file.exists():
        audio_file = Path(__file__).resolve().parents[2] / 'web/src/lib/atlas-audio-profiles.json'
    if info['mode'] == 'audio' and audio_file.exists():
        result['audio_options'] = json.loads(audio_file.read_text(encoding='utf-8')).get(profile['model'], {})
    return bridge.redact(result)


@mcp.tool(annotations=READ)
async def beeftv_estimate_cost(request: GenerationRequest) -> dict[str, Any]:
    """Estimate current Atlas cost without creating a generation task. Reuse the same request for generate."""
    return await bridge.estimate(request)


@mcp.tool(annotations=WRITE)
async def beeftv_generate(request: GenerationRequest, request_id: str, max_cost_usd: float | None = None) -> dict[str, Any]:
    """Submit a paid-capable async generation task. request_id deduplicates retries across MCP restarts. Optional max_cost_usd limits the preflight estimate, not final billing."""
    return await bridge.generate(request, request_id, max_cost_usd)


@mcp.tool(annotations=READ)
async def beeftv_get_task(task_id: str) -> dict[str, Any]:
    """Read task status and parsed generation results, including storageKey references."""
    return bridge.task_result(await bridge.api('GET', '/tasks/' + quote(task_id, safe='')))


@mcp.tool(annotations=READ)
async def beeftv_list_tasks(project_id: str = '', active_only: bool = False, limit: int = 20) -> dict[str, Any]:
    """List recent generation tasks; excludes input bodies and provider credentials."""
    tasks = await bridge.api('GET', '/tasks', params={'projectId': project_id, 'activeOnly': str(active_only).lower(), 'pageSize': min(100, max(1, limit))})
    return {'tasks': [bridge.task_result(task) for task in tasks]}


@mcp.tool(annotations=READ)
async def beeftv_wait_task(task_id: str, timeout_seconds: int = 45) -> dict[str, Any]:
    """Poll for at most 50 seconds. If still running, call again with the same task_id; never generate again."""
    return await bridge.wait(task_id, timeout_seconds)


@mcp.tool(annotations=WRITE)
async def beeftv_cancel_task(task_id: str) -> dict[str, Any]:
    """Request task cancellation. Already incurred provider charges are not guaranteed refundable."""
    result = await bridge.api('POST', '/tasks/' + quote(task_id, safe='') + '/cancel', json={})
    return bridge.redact(result)


@mcp.tool(annotations=WRITE)
async def beeftv_upload_file(path: str, kind: str) -> dict[str, Any]:
    """Upload an absolute local image/video/audio path to BeefTV. Use returned storageKey in generation references."""
    return await bridge.upload(path, kind)


@mcp.tool(annotations=WRITE)
async def beeftv_download_result(resource_id: str, output_path: str) -> dict[str, Any]:
    """Save a BeefTV-owned result resource to a new absolute file path. Strip 'resource:' from storageKey for resource_id."""
    return await bridge.download(resource_id, output_path)


if __name__ == '__main__':
    mcp.run(transport='stdio')
