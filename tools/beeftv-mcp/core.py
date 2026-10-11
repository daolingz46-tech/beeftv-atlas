"""Desktop API bridge. Provider secrets never become MCP arguments or results."""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Media(BaseModel):
    model_config = ConfigDict(extra='forbid')
    storageKey: str = ''
    url: str = ''
    name: str = ''
    width: int = Field(default=0, ge=0)
    height: int = Field(default=0, ge=0)
    durationMs: int = Field(default=0, ge=0)
    bytes: int = Field(default=0, ge=0)

    @model_validator(mode='after')
    def valid_source(self):
        if bool(self.storageKey) == bool(self.url):
            raise ValueError('Provide exactly one storageKey or public URL')
        if self.storageKey and not re.fullmatch(r'resource:[A-Za-z0-9_-]+', self.storageKey):
            raise ValueError('Use the resource:ID returned by upload_file')
        if self.url and urlsplit(self.url).scheme not in ('http', 'https'):
            raise ValueError('Media URLs must be http(s); upload local files first')
        return self


class GenerationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model_id: str = Field(description='Exact channel::model ID from list_models')
    prompt: str = Field(min_length=1, max_length=32000)
    settings: dict[str, str | int | float | bool] = Field(default_factory=dict, description='Use model_details defaults and allowed settings')
    operation: str = Field(default='', description='Video operation from model_details, e.g. reference_to_video')
    reference_images: list[Media] = Field(default_factory=list, max_length=20)
    reference_videos: list[Media] = Field(default_factory=list, max_length=20)
    reference_audios: list[Media] = Field(default_factory=list, max_length=20)
    mask: Media | None = None
    project_id: str = ''


SETTING_NAMES = {'size', 'quality', 'imageResolution', 'transparentBackground', 'videoSeconds', 'vquality', 'videoGenerateAudio', 'videoWatermark', 'audioVoice', 'audioFormat', 'audioSpeed', 'audioInstructions', 'systemPrompt'}
SECRET_NAMES = {'apikey', 'secretkey', 'launchtoken', 'ownertoken', 'authorization', 'cookie', 'headers', 'credentialref', 'inputjson'}


@contextmanager
def journal_connection(path):
    connection = sqlite3.connect(path, timeout=10)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


class Bridge:
    def __init__(self, data_dir=None, transport=None):
        self.data_dir = Path(data_dir or os.environ.get('BEEFTV_DATA_DIR') or Path(os.environ.get('APPDATA', Path.home() / '.config')) / 'BeefTV')
        self.transport = transport
        self.secrets = set()

    def redact(self, value):
        if isinstance(value, dict):
            return {key: self.redact(item) for key, item in value.items() if key.lower() not in SECRET_NAMES}
        if isinstance(value, list):
            return [self.redact(item) for item in value]
        if isinstance(value, str):
            for secret in self.secrets:
                if len(secret) > 3:
                    value = value.replace(secret, '[redacted]')
        return value

    def connection(self):
        try:
            config = json.loads((self.data_dir / 'mcp-runtime.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise RuntimeError('BeefTV 未运行或尚未更新 MCP 支持，请先打开 BeefTV') from None
        endpoint = urlsplit(config.get('baseURL', ''))
        if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or not endpoint.port or endpoint.path != '/api' or endpoint.query or endpoint.fragment or endpoint.username:
            raise RuntimeError('Invalid local BeefTV runtime address')
        if not config.get('launchToken'):
            raise RuntimeError('Missing desktop session token')
        self.secrets.add(config['launchToken'])
        return config

    async def api(self, method, path, **kwargs):
        config = self.connection()
        headers = self.local_headers(config, path)
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False, timeout=50) as client:
                response = await client.request(method, config['baseURL'] + path, headers=headers, **kwargs)
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise RuntimeError('BeefTV 连接中断；写操作没有自动重试，请查询任务后再决定是否重新提交') from None
        if response.status_code >= 300 or body.get('code') != 0:
            raise RuntimeError(str(self.redact(body.get('msg') or f'BeefTV API error {response.status_code}'))) from None
        return body.get('data')

    def local_headers(self, config, path):
        headers = {'X-Desktop-Token': config['launchToken']}
        # The trusted local bridge reads provider configuration internally; its
        # public tools redact it. Business writes use the official owner boundary.
        owner_file = self.data_dir / 'agent_owner_token'
        if path != '/workspace/model-config' and owner_file.exists():
            owner = owner_file.read_text(encoding='utf-8').strip()
            if not re.fullmatch(r'[a-f0-9]{64}', owner):
                raise RuntimeError('Invalid local BeefTV owner credential')
            self.secrets.add(owner)
            headers['X-Beeftv-Owner'] = owner
        return headers

    async def catalog(self):
        result = await self.api('GET', '/workspace/model-config')
        config = result.get('config') or {}
        items = []
        for channel in config.get('channels', []):
            for field in ('apiKey', 'secretKey'):
                if channel.get(field): self.secrets.add(channel[field])
            profiles = {p['model']: p for p in channel.get('modelProfiles', [])}
            for name in channel.get('models', []):
                profile = profiles.get(name, {})
                mode = profile.get('capability', '')
                if mode not in ('image', 'video', 'audio', 'text'):
                    continue
                ready = channel.get('enabled', True) and bool(profile.get('protocol')) and bool(channel.get('apiKey') or channel.get('credentialRef'))
                items.append((channel, profile, {'model_id': channel['id'] + '::' + name, 'name': profile.get('displayName') or name, 'family': profile.get('family') or name.split('/')[0], 'mode': mode, 'available': bool(ready)}))
        return items

    async def model(self, model_id):
        for channel, profile, info in await self.catalog():
            if info['model_id'] == model_id:
                return channel, profile, info
        raise ValueError('Unknown model_id; copy an exact ID from list_models')

    @staticmethod
    def defaults(profile):
        mode = profile.get('capability')
        cap = profile.get('capabilityConfig', {}).get(mode, {})
        if mode == 'image':
            return {'size': cap.get('size', {}).get('default', 'auto'), 'quality': cap.get('quality', {}).get('default', 'medium'), 'imageResolution': cap.get('resolution', {}).get('default', ''), 'count': '1'}
        if mode == 'video':
            return {'size': cap.get('defaultRatio', ''), 'vquality': cap.get('defaultResolution', ''), 'videoSeconds': str(cap.get('duration', {}).get('default', 5)), 'videoGenerateAudio': str(cap.get('generateAudio', {}).get('default', False)).lower(), 'videoWatermark': str(cap.get('watermark', {}).get('default', False)).lower()}
        return {}

    async def payload(self, request):
        channel, profile, info = await self.model(request.model_id)
        if not info['available']: raise ValueError('Model/channel is disabled, lacks a protocol or lacks credentials')
        unknown = set(request.settings) - SETTING_NAMES
        if unknown: raise ValueError('Unsupported settings: ' + ', '.join(sorted(unknown)))
        mode = info['mode']
        cap = profile.get('capabilityConfig', {})
        options = self.defaults(profile)
        options.update({key: str(value).lower() if isinstance(value, bool) else str(value) for key, value in request.settings.items()})
        # Custom local channels use their provider config, never hosted channelId.
        options.update({key: channel.get(key, '') for key in ('baseUrl', 'apiKey', 'secretKey', 'apiFormat', 'credentialRef')})
        options.update(model=profile['model'], interfaceType=profile['protocol'], capabilityConfig=cap, headers=channel.get('headers', []))
        operation = request.operation or (cap.get('video', {}).get('defaultOperation', 'text_to_video') if mode == 'video' else mode)
        if mode == 'video' and operation not in cap.get('video', {}).get('operations', []):
            raise ValueError('Unsupported video operation for this model')
        if mode != 'video' and request.operation:
            raise ValueError('operation is only used by video models')
        inputs = {'mode': mode, 'prompt': request.prompt, 'config': options, 'metadata': {'source': 'external-mcp'}}
        if mode == 'video': inputs['metadata']['videoEditOperation'] = operation
        for key, values in (('referenceImages', request.reference_images), ('referenceVideos', request.reference_videos), ('referenceAudios', request.reference_audios)):
            inputs[key] = [value.model_dump(exclude_defaults=True) for value in values]
        if request.mask: inputs['mask'] = request.mask.model_dump(exclude_defaults=True)
        return {'type': 'canvas_' + mode, 'operation': operation, 'prompt': request.prompt, 'model': request.model_id, 'projectId': request.project_id, 'input': inputs}

    async def estimate(self, request):
        payload = await self.payload(request)
        return self.redact(await self.api('POST', '/workspace/model-cost', json=payload['input']))

    def task_result(self, task):
        result = {key: task[key] for key in ('id', 'type', 'status', 'stage', 'progress', 'model', 'projectId', 'error', 'errorCode', 'createdAt', 'completedAt', 'providerCancelStatus') if key in task}
        raw = task.get('resultJson')
        try:
            inputs = json.loads(task.get('inputJson') or '{}')
            request_id = inputs.get('metadata', {}).get('mcpRequestId')
            if request_id: result['request_id'] = request_id
        except (ValueError, TypeError):
            pass
        if raw:
            try: result['result'] = json.loads(raw) if isinstance(raw, str) else raw
            except ValueError: result['result'] = raw
        return self.redact(result)

    async def generate(self, request, request_id, max_cost_usd=None):
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request_id):
            raise ValueError('request_id must contain 8-128 letters, digits, underscores or hyphens; reuse it for retries')
        fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        journal = self.data_dir / 'mcp-requests.sqlite3'
        with journal_connection(journal) as db:
            db.execute('CREATE TABLE IF NOT EXISTS submissions (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT)')
            existing = db.execute('SELECT fingerprint, task_id FROM submissions WHERE request_id=?', (request_id,)).fetchone()
        if existing:
            if existing[0] != fingerprint: raise ValueError('request_id already belongs to different arguments')
            if not existing[1]: raise RuntimeError('Submission outcome unknown or in progress; inspect list_tasks. This request_id will not submit twice.')
            return self.task_result(await self.api('GET', '/tasks/' + quote(existing[1], safe='')))
        payload = await self.payload(request)
        if max_cost_usd is not None:
            if not math.isfinite(max_cost_usd) or max_cost_usd <= 0: raise ValueError('max_cost_usd must be finite and positive')
            cost = await self.api('POST', '/workspace/model-cost', json=payload['input'])
            price = cost.get('price')
            if not isinstance(price, (int, float)) or not math.isfinite(price) or price < 0 or cost.get('currency') != 'USD' or price > max_cost_usd:
                raise ValueError('Estimated cost exceeds max_cost_usd or currency cannot be compared')
        # Claim before the HTTP write; even process crashes and concurrent MCP clients
        # cannot turn an ambiguous timeout into a duplicate paid submission.
        with journal_connection(journal) as db:
            try: db.execute('INSERT INTO submissions VALUES (?, ?, NULL)', (request_id, fingerprint))
            except sqlite3.IntegrityError: raise RuntimeError('request_id was claimed concurrently; query it again') from None
        payload['input']['metadata']['mcpRequestId'] = request_id
        task = await self.api('POST', '/tasks', json=payload)
        if not task.get('id'): raise RuntimeError('Submission returned no task ID; do not blindly retry')
        with journal_connection(journal) as db:
            db.execute('UPDATE submissions SET task_id=? WHERE request_id=?', (task['id'], request_id))
        return self.task_result(task)

    async def wait(self, task_id, timeout_seconds=45):
        deadline = time.monotonic() + min(50, max(1, timeout_seconds))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0: return self.task_result(task)
            try:
                task = await asyncio.wait_for(self.api('GET', '/tasks/' + quote(task_id, safe='')), timeout=remaining)
            except TimeoutError:
                if 'task' in locals(): return self.task_result(task)
                raise RuntimeError('Task lookup timed out; query the same task_id again') from None
            if task.get('status') in ('succeeded', 'failed', 'cancelled', 'canceled') or time.monotonic() >= deadline:
                return self.task_result(task)
            await asyncio.sleep(min(2, max(0, deadline - time.monotonic())))

    async def upload(self, path, kind):
        source = Path(path)
        if not source.is_absolute() or not source.is_file(): raise ValueError('Use an existing absolute file path')
        if kind not in ('image', 'video', 'audio'): raise ValueError('kind must be image, video or audio')
        with source.open('rb') as stream:
            result = await self.api('POST', '/resources', files={'file': (source.name, stream)}, data={'kind': kind})
        resource = result['resource']
        return self.redact({'storageKey': 'resource:' + resource['id'], 'resource': resource})

    async def download(self, resource_id, output_path):
        target = Path(output_path)
        if not target.is_absolute() or target.exists(): raise ValueError('Use a new absolute output path; existing files will not be overwritten')
        target.parent.mkdir(parents=True, exist_ok=True)
        config = self.connection()
        url = config['baseURL'] + '/resources/' + quote(resource_id, safe='') + '/file?proxy=1&direct=1'
        created = False
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False, timeout=60) as client:
                async with client.stream('GET', url, headers=self.local_headers(config, '/resources')) as response:
                    if response.status_code != 200: raise RuntimeError(f'Resource download failed ({response.status_code})')
                    with target.open('xb') as stream:
                        created = True
                        async for chunk in response.aiter_bytes(): stream.write(chunk)
        except BaseException:
            # A failed transfer must not masquerade as a usable result.
            if created and target.exists(): target.unlink()
            raise
        return {'path': str(target), 'bytes': target.stat().st_size}
