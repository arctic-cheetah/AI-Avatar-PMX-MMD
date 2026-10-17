import asyncio
import json
import unittest
from argparse import Namespace
from unittest.mock import patch
from controller.bridge import TagParser, load_catalog, system_prompt, llama_chunks, handle_connection, ORIGIN, DEMO


class ParserTests(unittest.TestCase):
    def parse(self, chunks):
        parser = TagParser(load_catalog())
        events = [e for c in chunks for e in parser.feed(c)] + parser.finish()
        return ''.join(e['text'] for e in events if e['type']=='say'), [e for e in events if e['type']=='expression']

    def test_every_split(self):
        expected=self.parse([DEMO])
        for i in range(len(DEMO)+1):
            self.assertEqual(self.parse([DEMO[:i],DEMO[i:]]),expected)
        self.assertEqual(self.parse(list(DEMO)),expected)
        self.assertEqual([e['name'] for e in expected[1]],['soft-smile','thinking','neutral'])
        self.assertNotIn('[',expected[0])

    def test_invalid_and_clamp(self):
        text, events=self.parse(['Hello [unknown][happy:nan][happy:inf][happy:2][sad:-1]', '['+'x'*500+'] end [hap'])
        self.assertEqual(text,'Hello  end ')
        self.assertEqual([e['weight'] for e in events],[1,0])

    def test_prompt(self):
        catalog=load_catalog()
        prompt=system_prompt(catalog)
        for name in catalog: self.assertIn('['+name+']',prompt)
        self.assertNotIn('笑い',prompt)


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_demo_origins(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus
        async def fast_demo():
            yield '[soft-'
            yield 'smile:0.6] Hello. [neutral]'
        args=Namespace(mode='demo')
        async def handler(ws): await handle_connection(ws,args,load_catalog())
        with patch('controller.bridge.demo_chunks',fast_demo):
            async with serve(handler,'127.0.0.1',0,origins=[ORIGIN]) as server:
                url=f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}'
                for origin in [None,'https://example.com','http://localhost:8770']:
                    with self.assertRaises(InvalidStatus):
                        async with connect(url,origin=origin): pass
                async with connect(url,origin=ORIGIN) as ws:
                    await ws.send('broken json')
                    await ws.send('{"type":"unknown"}')
                    for _ in range(2):
                        await ws.send('{"type":"start"}')
                        events=[]
                        while True:
                            event=json.loads(await asyncio.wait_for(ws.recv(),3))
                            events.append(event)
                            if event['type']=='end': break
                        self.assertEqual(''.join(e['text'] for e in events if e['type']=='say'),' Hello. ')
                        self.assertEqual(events[-2]['name'],'neutral')

    async def test_llama_sse(self):
        import httpx
        chunks=['[soft-','smile:0.6]',' Hello']
        body=': heartbeat\n\ndata: '+json.dumps({'choices':[{'delta':{'reasoning_content':'private reasoning'}}]})+'\n\n'
        body+=''.join('data: '+json.dumps({'choices':[{'delta':{'content':c}}]})+'\n\n' for c in chunks)+'data: [DONE]'
        def handler(request):
            self.assertEqual(request.url.path,'/v1/chat/completions')
            self.assertTrue(json.loads(request.content)['stream'])
            return httpx.Response(200,text=body)
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('httpx.AsyncClient',return_value=client):
            self.assertEqual([c async for c in llama_chunks('http://localhost:8080',None,'Hi',load_catalog())],chunks)

    async def test_truncated_stream(self):
        import httpx
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,text='data: {"choices":[]}\n\n')))
        with patch('httpx.AsyncClient',return_value=client):
            with self.assertRaisesRegex(ValueError,'without'):
                _=[c async for c in llama_chunks('http://localhost:8080',None,'Hi',load_catalog())]

    async def test_error_and_disconnect(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        async def broken(*args):
            raise ValueError('test upstream error')
            yield ''
        args=Namespace(mode='llm',llama_url='http://localhost:8080',model=None,prompt='Hi')
        async def handler(ws): await handle_connection(ws,args,load_catalog())
        with patch('controller.bridge.llama_chunks',broken):
            async with serve(handler,'127.0.0.1',0,origins=[ORIGIN]) as server:
                async with connect(f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}',origin=ORIGIN) as ws:
                    await ws.send('{"type":"start"}')
                    events=[json.loads(await asyncio.wait_for(ws.recv(),3)) for _ in range(4)]
                    self.assertEqual(events[-1]['type'],'error')
                    self.assertEqual(events[-2]['name'],'neutral')

if __name__=='__main__': unittest.main()
