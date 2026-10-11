"""Actual MCP handshake and tool calls against a synthetic desktop HTTP backend."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class StdioTests(unittest.IsolatedAsyncioTestCase):
    async def test_standard_client_handshake_and_read_tools(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_GET(self):
                assert self.headers['X-Desktop-Token'] == 'synthetic-session'
                data = {}
                if self.path.endswith('/model-config'):
                    data = {'config': {'channels': [{'id': 'synthetic', 'enabled': True, 'apiKey': 'synthetic-provider-secret', 'models': ['synthetic-image'], 'modelProfiles': [{'model': 'synthetic-image', 'capability': 'image', 'protocol': 'synthetic-protocol', 'capabilityConfig': {'version': 1, 'image': {'size': {'default': '3:4'}}}}]}]}}
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'code': 0, 'data': data}).encode())

            def do_POST(self):
                raise AssertionError('Readonly MCP protocol test must not submit anything')

        with tempfile.TemporaryDirectory() as temporary:
            backend = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=backend.serve_forever, daemon=True)
            thread.start()
            try:
                Path(temporary, 'mcp-runtime.json').write_text(json.dumps({'baseURL': f'http://127.0.0.1:{backend.server_port}/api', 'launchToken': 'synthetic-session'}), encoding='utf-8')
                parameters = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name('server.py'))], env={**os.environ, 'BEEFTV_DATA_DIR': temporary, 'PYTHONUTF8': '1'})
                async with stdio_client(parameters) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        self.assertEqual(len(tools.tools), 11)
                        generate = next(tool for tool in tools.tools if tool.name == 'beeftv_generate')
                        self.assertIn('request_id', generate.inputSchema['required'])
                        for name, args in [('beeftv_status', {}), ('beeftv_list_models', {'mode': 'image'}), ('beeftv_model_details', {'model_id': 'synthetic::synthetic-image'})]:
                            result = await session.call_tool(name, args)
                            self.assertFalse(result.isError)
                            self.assertIsNotNone(result.structuredContent)
                            self.assertNotIn('synthetic-provider-secret', result.model_dump_json())
                            self.assertNotIn('synthetic-session', result.model_dump_json())
            finally:
                backend.shutdown()
                backend.server_close()
                thread.join()


if __name__ == '__main__': unittest.main()
