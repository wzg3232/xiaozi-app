import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const temporary=mkdtempSync(join(tmpdir(),'xiaozi-enterprise-test-')),fixtures=[];
const secret='test-only-server-secret',model='explicit-test-model';
let upstream,upstreamBase;const upstreamCalls=[];
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(fn){for(let i=0;i<80;i++){if(fn())return;await tick(25);}throw Error('Condition not reached');}
function fixture(name){
  const result={database:join(temporary,name+'.sqlite'),base:'',stderr:'',child:null,
    async start(extra={}){
      this.stderr='';this.child=spawn(process.execPath,[resolve('server/index.mjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DB_PATH:this.database,MEDIA_DIR:join(temporary,name+'-uploads'),ICHAT_DEMO:'0',XIAOZI_LLM_API_KEY:'',XIAOZI_LLM_BASE_URL:'',XIAOZI_LLM_MODEL:'',XIAOZI_ENTERPRISE_CONFIG:'',XIAOZI_ALLOW_HTTP_LOOPBACK:'1',...extra},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout: '+this.stderr)),10000);this.child.stderr.on('data',chunk=>this.stderr+=chunk);this.child.stdout.on('data',chunk=>{const match=chunk.toString().match(/listening on (http:\/\/\S+)/);if(match){this.base=match[1];clearTimeout(timer);accept();}});this.child.once('error',reject);this.child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected exit '+code+': '+this.stderr));});});
    },
    async stop(){const child=this.child;if(!child||child.exitCode!==null)return;await new Promise(accept=>{const timer=setTimeout(()=>{child.kill();accept();},4000);child.once('exit',()=>{clearTimeout(timer);accept();});child.send('shutdown');});},
    async request(route,{method='GET',token,body,signal,headers={}}={}){return fetch(this.base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined,signal});},
    async call(route,options){const response=await this.request(route,options);return {status:response.status,data:await response.json()};},
    async account(prefix='user'){const name=prefix+'_'+randomUUID().slice(0,8);const response=await this.call('/api/register',{method:'POST',body:{username:name,displayName:name,password:'TestOnlyPassword2026!'}});assert.equal(response.status,201);return response.data;},
    async conversation(account){const response=await this.call('/api/ai/conversations',{method:'POST',token:account.token,body:{}});assert.equal(response.status,201);return response.data.conversation;},
    rows(id){const db=new DatabaseSync(this.database,{readOnly:true});try{return db.prepare('SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY seq').all(id);}finally{db.close();}}
  };fixtures.push(result);return result;
}
const app=fixture('ai'),unconfigured=fixture('unconfigured'),platform=fixture('platform');
const messagePath=c=>'/api/ai/conversations/'+c.id+'/messages';
const conversationPath=c=>'/api/ai/conversations/'+c.id;
function events(raw){return raw.split('\n\n').map(frame=>{const kind=frame.match(/^event: (.+)$/m),data=frame.match(/^data: (.+)$/m);return kind&&data?{event:kind[1],data:JSON.parse(data[1])}:null;}).filter(Boolean);}
async function readFirstDelta(reader){let raw='';const decoder=new TextDecoder();while(!raw.includes('event: delta')){const {done,value}=await reader.read();assert.equal(done,false,'stream ended before delta');raw+=decoder.decode(value,{stream:true});}return raw;}
async function ask(account,conversation,content,clientId=randomUUID(),retry=false){const response=await app.request(messagePath(conversation),{method:'POST',token:account.token,body:{content,clientId,...(retry?{retry:true}:{})}});return {status:response.status,events:events(await response.text()),clientId};}
async function heldPost(route,token,input){
  const bytes=Buffer.from(JSON.stringify(input));let request,readyAccept,readyReject;
  const ready=new Promise((accept,reject)=>{readyAccept=accept;readyReject=reject;});
  const response=new Promise((accept,reject)=>{request=http.request(app.base+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':bytes.length,Expect:'100-continue'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{let data;try{data=JSON.parse(Buffer.concat(chunks));}catch{}accept({status:res.statusCode,data});});});request.on('error',error=>{readyReject(error);reject(error);});});
  const timer=setTimeout(()=>readyReject(Error('Held request timeout')),2000);request.once('continue',()=>{clearTimeout(timer);request.write(bytes.subarray(0,1));readyAccept();});request.flushHeaders();await ready;
  return {async finish(){request.end(bytes.subarray(1));return response;}};
}
before(async()=>{
  upstream=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/energy')){upstreamCalls.push({url:req.url,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source:'owned-test-platform',value:42,query:new URL(req.url,'http://localhost').searchParams.get('q')}));return;}
    if(req.url.startsWith('/redirect')){res.writeHead(302,{Location:upstreamBase+'/energy'});res.end();return;}
    if(req.url.startsWith('/malformed')){res.setHeader('Content-Type','application/json');res.end('<html>not-json</html>');return;}
    let bytes='';for await(const chunk of req)bytes+=chunk;const input=JSON.parse(bytes),question=input.messages.at(-1).content;upstreamCalls.push({url:req.url,authorization:req.headers.authorization,input});
    if(question==='permission-failure'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'sensitive upstream raw '+secret}));return;}
    if(question==='json-answer'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'兼容非流式返回'}}]}));return;}
    if(question==='retry-once'&&upstreamCalls.filter(call=>call.input?.messages.at(-1).content===question).length===1){res.writeHead(503);res.end('sensitive raw '+secret);return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const delta=text=>res.write('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\r\n\r\n');
    delta('你好，');
    if(question==='finish-with-partial-trailer'){res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\r\n\r\ndata: [DO');return;}
    if(question==='slow-abort'||question==='revoke-session')await tick(1300);
    if(res.destroyed)return;
    if(question==='broken-stream'){res.end();return;}
    if(question==='bad-frame'){res.end('data: invalid-json\n\n');return;}
    delta('我是小紫。');res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\r\n\r\ndata: [DONE]\r\n\r\n');
  });
  await new Promise(accept=>upstream.listen(0,'127.0.0.1',accept));upstreamBase='http://127.0.0.1:'+upstream.address().port;
  await app.start({XIAOZI_LLM_API_KEY:secret,XIAOZI_LLM_BASE_URL:upstreamBase+'/v1',XIAOZI_LLM_MODEL:model});await unconfigured.start();await platform.start();
});
after(async()=>{for(const item of fixtures)await item.stop();if(upstream)await new Promise(accept=>{upstream.close(accept);upstream.closeAllConnections();});rmSync(temporary,{recursive:true,force:true});});

test('AI and enterprise endpoints require authentication and disclose no credentials',async()=>{
  for(const route of ['/api/ai/status','/api/ai/conversations','/api/enterprise/workspace','/api/enterprise/modules/energy'])assert.equal((await app.call(route)).status,401);
  const user=await app.account('status'),status=await app.call('/api/ai/status',{token:user.token});assert.equal(status.data.configured,true);assert.equal(status.data.model,model);assert.equal(JSON.stringify(status).includes(secret),false);
  const cors=await app.request('/api/ai/conversations',{method:'OPTIONS',headers:{Origin:'capacitor://localhost'}});assert.match(cors.headers.get('access-control-allow-methods'),/DELETE/);
});
test('unconfigured model and platforms report actual state without fake data or administrators',async()=>{
  const user=await unconfigured.account(),status=await unconfigured.call('/api/ai/status',{token:user.token});assert.equal(status.data.configured,false);assert.match(status.data.reason,/密钥/);
  const workspace=(await unconfigured.call('/api/enterprise/workspace',{token:user.token})).data;assert.equal(workspace.role,null);assert.equal(workspace.connectedCount,0);assert.equal(workspace.modules.length,4);for(const module of workspace.modules){assert.equal(module.status,'unconfigured');assert.deepEqual(module.capabilities,{query:false,control:false,approval:false});}
  const conversation=await unconfigured.conversation(user),response=await unconfigured.call(messagePath(conversation),{method:'POST',token:user.token,body:{content:'test',clientId:randomUUID()}});assert.equal(response.status,503);assert.equal(unconfigured.rows(conversation.id).length,0);
  assert.equal((await unconfigured.call('/api/enterprise/modules/energy',{token:user.token})).status,503);
  assert.equal((await unconfigured.call('/api/enterprise/modules/energy/control',{method:'POST',token:user.token,body:{action:'anything'}})).status,403);
});
test('streamed answers persist under owner and idempotent replay avoids duplicate model charges',async()=>{
  const user=await app.account('stream'),conversation=await app.conversation(user),clientId=randomUUID(),before=upstreamCalls.length;
  const result=await ask(user,conversation,'test-stream',clientId);assert.equal(result.status,200);assert.deepEqual(result.events.map(e=>e.event),['meta','delta','delta','done']);assert.equal(result.events.at(-1).data.message.content,'你好，我是小紫。');
  const stored=(await app.call(conversationPath(conversation),{token:user.token})).data;assert.equal(stored.messages.length,2);assert.equal(stored.messages[1].status,'complete');assert.equal(stored.messages[1].clientId,clientId);
  const replay=await ask(user,conversation,'test-stream',clientId);assert.equal(replay.events.at(-1).event,'done');assert.equal(upstreamCalls.length,before+1);assert.equal(upstreamCalls.at(-1).authorization,'Bearer '+secret);assert.equal(upstreamCalls.at(-1).input.model,model);assert.equal(JSON.stringify(stored).includes(secret),false);
  assert.equal((await app.call(messagePath(conversation),{method:'POST',token:user.token,body:{content:'changed',clientId}})).status,409);
});
test('other accounts cannot read, write or delete an AI conversation',async()=>{
  const owner=await app.account('owner'),other=await app.account('other'),conversation=await app.conversation(owner);
  assert.deepEqual((await app.call('/api/ai/conversations',{token:other.token})).data.conversations,[]);
  for(const method of ['GET','DELETE'])assert.equal((await app.call(conversationPath(conversation),{method,token:other.token})).status,404);
  assert.equal((await app.call(messagePath(conversation),{method:'POST',token:other.token,body:{content:'test',clientId:randomUUID()}})).status,404);
  assert.equal((await app.call(conversationPath(conversation),{method:'DELETE',token:owner.token})).status,200);assert.equal((await app.call(conversationPath(conversation),{token:owner.token})).status,404);
});
test('permission failures are safe and failed answers retry without duplicate questions or failed context',async()=>{
  const user=await app.account('retry'),conversation=await app.conversation(user);
  const denied=await ask(user,conversation,'permission-failure');assert.equal(denied.events.at(-1).event,'error');assert.match(denied.events.at(-1).data.message,/无权访问/);assert.equal(JSON.stringify(denied).includes(secret),false);assert.equal(app.rows(conversation.id)[1].status,'failed');
  const first=await ask(user,conversation,'retry-once');assert.equal(first.events.at(-1).event,'error');const retried=await ask(user,conversation,'retry-once',first.clientId,true);assert.equal(retried.events.at(-1).event,'done');assert.equal(app.rows(conversation.id).length,4);assert.equal(app.rows(conversation.id)[3].status,'complete');
  assert.equal(upstreamCalls.at(-1).input.messages.some(message=>message.content==='permission-failure'),false);
});
test('incomplete or malformed streams stay failed while JSON-compatible responses work',async()=>{
  const user=await app.account('formats');for(const question of ['broken-stream','bad-frame']){const conversation=await app.conversation(user),result=await ask(user,conversation,question);assert.equal(result.events.at(-1).event,'error');assert.equal(app.rows(conversation.id)[1].status,'failed');}
  const conversation=await app.conversation(user),result=await ask(user,conversation,'json-answer');assert.equal(result.events.at(-1).event,'done');assert.equal(result.events.at(-1).data.message.content,'兼容非流式返回');
});
test('a valid final SSE frame is complete even when a following optional trailer is split',async()=>{
  const user=await app.account('trailer'),conversation=await app.conversation(user),result=await ask(user,conversation,'finish-with-partial-trailer');
  assert.equal(result.events.at(-1).event,'done');assert.equal(result.events.at(-1).data.message.content,'你好，');assert.equal(app.rows(conversation.id)[1].status,'complete');
});
test('client cancellation after text arrives persists stopped content and releases active request',async()=>{
  const user=await app.account('abort'),conversation=await app.conversation(user),controller=new AbortController();
  const response=await app.request(messagePath(conversation),{method:'POST',token:user.token,body:{content:'slow-abort',clientId:randomUUID()},signal:controller.signal}),reader=response.body.getReader();await readFirstDelta(reader);controller.abort();await reader.cancel().catch(()=>{});
  await eventually(()=>app.rows(conversation.id)[1]?.status==='stopped');assert.equal(app.rows(conversation.id)[1].content,'你好，');
  const next=await app.conversation(user),result=await ask(user,next,'after-abort');assert.equal(result.events.at(-1).event,'done');
});
test('logout during an active model stream stops subsequent text and revokes history access',async()=>{
  const user=await app.account('revoke'),conversation=await app.conversation(user);
  const response=await app.request(messagePath(conversation),{method:'POST',token:user.token,body:{content:'revoke-session',clientId:randomUUID()}}),reader=response.body.getReader();await readFirstDelta(reader);
  assert.equal((await app.call('/api/logout',{method:'POST',token:user.token,body:{}})).status,200);let rest='';while(true){const chunk=await reader.read();if(chunk.done)break;rest+=new TextDecoder().decode(chunk.value);}assert.equal(rest.includes('我是小紫。'),false);assert.equal(app.rows(conversation.id)[1].status,'failed');assert.equal((await app.call(conversationPath(conversation),{token:user.token})).status,401);
});
test('AI input limits, concurrency, deletion during a stream and full advertised Chinese input are enforced',async()=>{
  const user=await app.account('limits'),conversation=await app.conversation(user);
  for(const content of ['', 'x'.repeat(8001)])assert.equal((await app.call(messagePath(conversation),{method:'POST',token:user.token,body:{content,clientId:randomUUID()}})).status,400);
  assert.equal((await app.call(messagePath(conversation),{method:'POST',token:user.token,body:{content:'test',clientId:'bad'}})).status,400);
  const controller=new AbortController(),response=await app.request(messagePath(conversation),{method:'POST',token:user.token,body:{content:'slow-abort',clientId:randomUUID()},signal:controller.signal});await readFirstDelta(response.body.getReader());
  assert.equal((await app.call(messagePath(conversation),{method:'POST',token:user.token,body:{content:'second',clientId:randomUUID()}})).status,409);
  assert.equal((await app.call(conversationPath(conversation),{method:'DELETE',token:user.token})).status,409);controller.abort();await eventually(()=>app.rows(conversation.id)[1]?.status==='stopped');
  const chinese=await ask(user,conversation,'中'.repeat(8000));assert.equal(chinese.status,200);assert.equal(chinese.events.at(-1).event,'done');
});
test('held AI writes recheck a revoked session before creating data or calling a model',async()=>{
  const user=await app.account('held'),conversation=await app.conversation(user),before=upstreamCalls.length;
  const held=await heldPost(messagePath(conversation),user.token,{content:'held-request',clientId:randomUUID()});
  assert.equal((await app.call('/api/logout',{method:'POST',token:user.token,body:{}})).status,200);
  assert.equal((await held.finish()).status,401);assert.equal(app.rows(conversation.id).length,0);assert.equal(upstreamCalls.length,before);
});
test('enterprise queries require explicit member permissions and only use configured destinations',async()=>{
  const allowed=await platform.account('employee'),outsider=await platform.account('outside'),configPath=join(temporary,'platform.json');await platform.stop();
  writeFileSync(configPath,JSON.stringify({organization:'测试能源企业',members:{[allowed.user.id]:{role:'employee',modules:['energy','knowledge','projects']}},modules:{energy:{url:upstreamBase+'/energy',tokenEnv:'XIAOZI_PLATFORM_ENERGY_TOKEN'},knowledge:{url:upstreamBase+'/redirect'},projects:{url:upstreamBase+'/malformed'}}}));
  await platform.start({XIAOZI_ENTERPRISE_CONFIG:configPath,XIAOZI_PLATFORM_ENERGY_TOKEN:'only-platform-test-key'});
  const workspace=(await platform.call('/api/enterprise/workspace',{token:allowed.token})).data;assert.equal(workspace.organization,'测试能源企业');assert.equal(workspace.connectedCount,3);assert.equal(workspace.role,'employee');assert.equal(workspace.modules[0].capabilities.control,false);assert.equal(JSON.stringify(workspace).includes('only-platform-test-key'),false);
  assert.equal((await platform.call('/api/enterprise/modules/energy',{token:outsider.token})).status,403);
  const result=await platform.call('/api/enterprise/modules/energy?q='+encodeURIComponent('上海储能')+'&url='+encodeURIComponent('https://evil.invalid'),{token:allowed.token});assert.equal(result.status,200);assert.equal(result.data.data.query,'上海储能');assert.equal(upstreamCalls.at(-1).authorization,'Bearer only-platform-test-key');assert.match(upstreamCalls.at(-1).url,/^\/energy\?q=/);assert.equal(upstreamCalls.at(-1).url.includes('evil.invalid'),false);
  for(const module of ['knowledge','projects'])assert.equal((await platform.call('/api/enterprise/modules/'+module,{token:allowed.token})).status,502);
  assert.equal((await platform.call('/api/enterprise/modules/energy/approval',{method:'POST',token:allowed.token,body:{approved:true}})).status,403);
});
