import asyncio
import json
from pathlib import Path
import tempfile
import unittest

import httpx
from pydantic import ValidationError

from core import Bridge, GenerationRequest, Media


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'mcp-runtime.json').write_text(json.dumps({'baseURL': 'http://127.0.0.1:1234/api', 'launchToken': 'session-secret'}), encoding='utf-8')
        self.calls = []
        self.fail_write = False
        self.config = {'channels': [{'id': 'atlas', 'apiKey': 'provider-secret', 'secretKey': '', 'baseUrl': 'https://api.atlascloud.ai', 'models': ['test-image'], 'enabled': True, 'modelProfiles': [{'model': 'test-image', 'capability': 'image', 'protocol': 'atlas-test', 'capabilityConfig': {'version': 1, 'image': {'size': {'default': '3:4'}, 'quality': {'default': 'low'}, 'resolution': {'default': '2k'}}}}]}]}
        self.bridge = Bridge(self.root, httpx.MockTransport(self.handle))
        self.request = GenerationRequest(model_id='atlas::test-image', prompt='Synthetic portrait', reference_images=[Media(storageKey='resource:test-reference')])

    def tearDown(self):
        self.temporary.cleanup()

    def handle(self, request):
        self.assertEqual(request.headers['X-Desktop-Token'], 'session-secret')
        body = json.loads(request.content) if request.content and request.headers.get('content-type', '').startswith('application/json') else None
        self.calls.append((request.method, request.url.path, body))
        if request.url.path.endswith('/model-config'):
            return httpx.Response(200, json={'code': 0, 'data': {'config': self.config}})
        if request.url.path.endswith('/model-cost'):
            return httpx.Response(200, json={'code': 0, 'data': {'price': .1, 'currency': 'USD', 'estimated': True}})
        if request.url.path.endswith('/file'):
            return httpx.Response(200, content=b'synthetic-file')
        if request.url.path.endswith('/resources') and request.method == 'POST':
            self.assertIn(b'filename="synthetic.png"', request.content)
            return httpx.Response(200, json={'code': 0, 'data': {'resource': {'id': 'synthetic-upload', 'kind': 'image', 'width': 768, 'height': 1024}}})
        if request.url.path.endswith('/tasks') and request.method == 'POST':
            if self.fail_write: raise httpx.ReadTimeout('ambiguous write')
            self.submitted = body
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'synthetic-task', 'status': 'queued', 'inputJson': json.dumps(body['input'])}})
        if '/tasks/' in request.url.path:
            return httpx.Response(200, json={'code': 0, 'data': {'id': 'synthetic-task', 'status': 'succeeded', 'inputJson': '{"apiKey":"provider-secret"}', 'resultJson': '{"images":[{"storageKey":"resource:output"}]}'}})
        return httpx.Response(400, json={'code': 1, 'msg': 'provider-secret session-secret'})

    async def test_exact_parameters_match_quote_and_generation(self):
        await self.bridge.estimate(self.request)
        result = await self.bridge.generate(self.request, 'test-request-001')
        cost = next(body for _, path, body in self.calls if path.endswith('/model-cost'))
        generation = self.submitted['input']
        self.assertEqual(cost['config'], generation['config'])
        self.assertEqual(generation['config']['size'], '3:4')
        self.assertEqual(generation['config']['quality'], 'low')
        self.assertEqual(generation['config']['imageResolution'], '2k')
        self.assertEqual(generation['config']['apiKey'], 'provider-secret')
        self.assertNotIn('channelId', generation['config'])
        self.assertEqual(generation['referenceImages'], [{'storageKey': 'resource:test-reference'}])
        self.assertEqual(result['request_id'], 'test-request-001')
        self.assertNotIn('secret', json.dumps(result))

    async def test_duplicate_survives_restart_and_rejects_modified_request(self):
        await self.bridge.generate(self.request, 'test-request-002')
        restarted = Bridge(self.root, httpx.MockTransport(self.handle))
        result = await restarted.generate(self.request, 'test-request-002')
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(sum(method == 'POST' and path.endswith('/tasks') for method, path, _ in self.calls), 1)
        modified = self.request.model_copy(update={'prompt': 'Different prompt'})
        with self.assertRaises(ValueError): await restarted.generate(modified, 'test-request-002')

    async def test_ambiguous_timeout_cannot_create_duplicate_paid_task(self):
        self.fail_write = True
        with self.assertRaises(RuntimeError): await self.bridge.generate(self.request, 'test-request-003')
        self.fail_write = False
        with self.assertRaises(RuntimeError): await self.bridge.generate(self.request, 'test-request-003')
        self.assertEqual(sum(path.endswith('/tasks') for _, path, _ in self.calls), 1)

    async def test_budget_gate_prevents_submission(self):
        with self.assertRaises(ValueError): await self.bridge.generate(self.request, 'test-request-004', .05)
        self.assertFalse(any(path.endswith('/tasks') for _, path, _ in self.calls))
        with self.assertRaises(ValueError): await self.bridge.generate(self.request, 'test-request-nan', float('nan'))
        self.assertFalse(any(path.endswith('/tasks') for _, path, _ in self.calls))

    async def test_auth_is_reloaded_after_restart(self):
        self.bridge.connection()
        (self.root / 'mcp-runtime.json').write_text(json.dumps({'baseURL': 'http://127.0.0.1:2345/api', 'launchToken': 'rotated-secret'}), encoding='utf-8')
        self.assertEqual(self.bridge.connection()['launchToken'], 'rotated-secret')

    async def test_nonlocal_runtime_and_media_rejected(self):
        (self.root / 'mcp-runtime.json').write_text(json.dumps({'baseURL': 'https://example.com/api', 'launchToken': 'session-secret'}), encoding='utf-8')
        with self.assertRaises(RuntimeError): self.bridge.connection()
        with self.assertRaises(ValidationError): Media(url='file:///secret.txt')
        with self.assertRaises(ValidationError): GenerationRequest(model_id='atlas::test-image', prompt='x', apiKey='leak')

    async def test_secrets_filtered_from_errors_and_results(self):
        await self.bridge.catalog()
        with self.assertRaisesRegex(RuntimeError, r'^\[redacted\] \[redacted\]$'):
            await self.bridge.api('GET', '/fail')
        self.assertEqual(self.bridge.task_result({'inputJson': '{"apiKey":"provider-secret"}', 'resultJson': '{"apiKey":"provider-secret","text":"ok"}'}), {'result': {'text': 'ok'}})

    async def test_download_and_existing_file_preserved(self):
        output = self.root / 'output.bin'
        result = await self.bridge.download('test-output', str(output))
        self.assertEqual(result['bytes'], 14)
        with self.assertRaises(ValueError): await self.bridge.download('test-output', str(output))
        self.assertEqual(output.read_bytes(), b'synthetic-file')

    async def test_upload_returns_owned_reference(self):
        source = self.root / 'synthetic.png'
        source.write_bytes(b'synthetic-test-media')
        result = await self.bridge.upload(str(source), 'image')
        self.assertEqual(result['storageKey'], 'resource:synthetic-upload')
        self.assertEqual(result['resource']['height'], 1024)

    async def test_wait_stops_on_terminal_state(self):
        result = await self.bridge.wait('synthetic-task', 45)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['result']['images'][0]['storageKey'], 'resource:output')


if __name__ == '__main__': unittest.main()
