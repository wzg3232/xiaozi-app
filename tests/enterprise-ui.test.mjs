import test from 'node:test';
import assert from 'node:assert/strict';
import {readSseEvents,normalizeEnterpriseModules} from '../web/assets/enterprise.js';

function stream(bytes,size=bytes.length){let offset=0;return new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}const end=Math.min(offset+size,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;}});}
const encoded=text=>new TextEncoder().encode(text);
async function collect(body,options){const events=[];for await(const event of readSseEvents(body,options))events.push(event);return events;}

test('SSE decoder preserves Chinese text and emoji across every byte boundary',async()=>{
  const text=': heartbeat\r\nevent: meta\r\ndata: {"conversationId":"owned-test"}\r\n\r\nevent: delta\r\ndata: {"text":"小紫你好🌸"}\r\n\r\nevent: done\r\ndata: {"message":{"status":"complete"}}\r\n\r\n';
  for(let size=1;size<=19;size++)assert.deepEqual(await collect(stream(encoded(text),size)),[
    {event:'meta',data:{conversationId:'owned-test'}},{event:'delta',data:{text:'小紫你好🌸'}},{event:'done',data:{message:{status:'complete'}}}
  ]);
});
test('multiline SSE data and a final event without trailing blank line remain readable',async()=>{
  const text='event: delta\ndata: {\ndata: "text":"能源分析"\ndata: }\n\nevent: done\ndata: {}';
  assert.deepEqual(await collect(stream(encoded(text),3)),[{event:'delta',data:{text:'能源分析'}},{event:'done',data:{}}]);
});
test('comments and empty heartbeat blocks do not become artificial messages',async()=>{
  const events=await collect(stream(encoded(': heartbeat\n\n\n\nevent: delta\ndata: {"text":""}\n\ndata: [DONE]\n\n'),1));
  assert.deepEqual(events,[{event:'delta',data:{text:''}},{event:'done',data:{}}]);
});
test('malformed JSON and oversized unfinished stream events fail rather than display invented replies',async()=>{
  await assert.rejects(collect(stream(encoded('event: delta\ndata: not-json\n\n'))),/格式不正确/);
  await assert.rejects(collect(stream(encoded('data: '+('x'.repeat(64)))),{maxBuffer:32}),/大小限制/);
});
test('abort stops already-buffered following events and releases the body reader',async()=>{
  const controller=new AbortController(),body=stream(encoded('event: delta\ndata: {"text":"一"}\n\nevent: delta\ndata: {"text":"二"}\n\n'));
  const iterator=readSseEvents(body,{signal:controller.signal});assert.equal((await iterator.next()).value.data.text,'一');controller.abort();
  await assert.rejects(iterator.next(),error=>error.name==='AbortError');assert.equal(body.locked,false);
});
test('leaving an unfinished stream cancels the reader instead of retaining a generation connection',async()=>{
  let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(encoded('event: delta\ndata: {"text":"开始"}\n\n'));},cancel(){cancelled=true;}});
  const iterator=readSseEvents(body);await iterator.next();await iterator.return();assert.equal(cancelled,true);assert.equal(body.locked,false);
});
test('unconfigured workspace shows all four real integration entry points without connected capabilities',()=>{
  const modules=normalizeEnterpriseModules(null);assert.equal(modules.length,4);assert.deepEqual(modules.map(m=>m.title),['能源管理','电价预测','知识库','项目进度']);
  for(const module of modules){assert.equal(module.status,'unconfigured');assert.deepEqual(module.capabilities,{query:false,control:false,approval:false});assert(!Object.hasOwn(module,'data'));}
});
test('forbidden and unknown integration status never grant a query even if server capability fields are inconsistent',()=>{
  const modules=normalizeEnterpriseModules({modules:[{id:'energy',status:'forbidden',capabilities:{query:true,control:true,approval:true}},{id:'prices',status:'online',capabilities:{query:true}}]});
  assert.equal(modules[0].status,'forbidden');assert.equal(modules[0].capabilities.query,false);assert.equal(modules[1].status,'unconfigured');assert.equal(modules[1].capabilities.query,false);
});
test('only an explicit connected and query-authorized module enables a read-only query',()=>{
  const modules=normalizeEnterpriseModules({modules:[{id:'actual-energy-api',title:'能源管理',status:'connected',capabilities:{query:true,control:true,approval:true},message:'已授权查询'}]});
  assert.equal(modules[0].id,'actual-energy-api');assert.equal(modules[0].message,'已授权查询');assert.deepEqual(modules[0].capabilities,{query:true,control:false,approval:false});
});
