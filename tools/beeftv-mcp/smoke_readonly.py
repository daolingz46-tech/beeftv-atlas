"""Read-only check of an installed MCP server. No uploads, quotes or generation."""
import asyncio
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def data(result):
    assert not result.isError, result.content
    return result.structuredContent or json.loads(result.content[0].text)


async def main():
    parameters = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name('server.py'))], env=dict(os.environ))
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert len(tools.tools) == 11
            status = await session.call_tool('beeftv_status', {})
            assert data(status)['running'], data(status)
            models = await session.call_tool('beeftv_list_models', {'mode': 'image', 'limit': 1})
            assert data(models)['models'], 'No configured image models'
            model_id = data(models)['models'][0]['model_id']
            details = await session.call_tool('beeftv_model_details', {'model_id': model_id})
            assert not details.isError
            tasks = await session.call_tool('beeftv_list_tasks', {'limit': 1})
            assert not tasks.isError
            print('PASS: MCP stdio handshake, 11 tools, desktop connection, model listing/details and task listing. No paid generation.')


if __name__ == '__main__': asyncio.run(main())
