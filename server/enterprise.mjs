import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const moduleDefinitions=[
  {id:'energy',title:'能源管理',description:'查看用能、储能与设备运行数据'},
  {id:'prices',title:'电价预测',description:'查询电价预测与历史价格'},
  {id:'knowledge',title:'企业知识库',description:'检索企业制度、资料与业务知识'},
  {id:'projects',title:'项目进度',description:'查看项目进度、里程碑与待办'}
];
const maxInput=8000,maxOutput=32000,maxTurns=100;
function serviceUrl(value,allowLoopback=false){
  const url=new URL(value);
  if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||allowLoopback&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Invalid service URL');
  return url;
}
function loadConfig(env){
  const config={members:{},modules:{},organization:null};
  if(!env.XIAOZI_ENTERPRISE_CONFIG)return config;
  try{
    const input=JSON.parse(readFileSync(env.XIAOZI_ENTERPRISE_CONFIG,'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input)||!input.members||typeof input.members!=='object'||Array.isArray(input.members))throw Error();
    config.organization=typeof input.organization==='string'?input.organization.slice(0,80):null;
    for(const [userId,member]of Object.entries(input.members)){
      if(!['employee','admin'].includes(member?.role)||!Array.isArray(member.modules)||member.modules.some(id=>!moduleDefinitions.some(m=>m.id===id)))throw Error();
      config.members[userId]={role:member.role,modules:[...new Set(member.modules)]};
    }
    for(const [id,module]of Object.entries(input.modules||{})){
      if(!moduleDefinitions.some(m=>m.id===id)||!module||typeof module!=='object')throw Error();
      const url=serviceUrl(module.url,env.XIAOZI_ALLOW_HTTP_LOOPBACK==='1');
      const tokenEnv=module.tokenEnv;
      if(tokenEnv&&(!/^XIAOZI_PLATFORM_[A-Z0-9_]+$/.test(tokenEnv)||!env[tokenEnv]))throw Error();
      const queryParameter=module.queryParameter||'q';if(!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(queryParameter))throw Error();
      config.modules[id]={url,token:tokenEnv?env[tokenEnv]:null,queryParameter};
    }
    return config;
  }catch{throw Error('企业平台配置无效，请检查服务端配置文件（未输出配置内容）');}
}
export function migrateEnterprise(db,transaction){
  transaction(()=>db.exec(`
    CREATE TABLE IF NOT EXISTS ai_conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_conversation_owner ON ai_conversations(user_id,updated_at);
    CREATE TABLE IF NOT EXISTS ai_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,status TEXT NOT NULL,client_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(conversation_id,client_id,role));
    CREATE INDEX IF NOT EXISTS ai_message_conversation ON ai_messages(conversation_id,seq);
    CREATE TABLE IF NOT EXISTS enterprise_query_audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),module_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
  `));
  // A process restart cannot resume an HTTP stream. Keep the partial text and allow retry.
  db.prepare("UPDATE ai_messages SET status='stopped' WHERE status='streaming'").run();
}
export function createEnterprise({db,transaction,body,json,requireSession,rateLimit,fail,nowISO,env=process.env,fetchImpl=fetch}){
  const platform=loadConfig(env),active=new Map(),activeUsers=new Map();
  let llmUrl=null,configReason='';
  if(!env.XIAOZI_LLM_API_KEY)configReason='小紫尚未配置服务端 API 密钥';
  else if(!env.XIAOZI_LLM_MODEL?.trim())configReason='小紫尚未配置模型名称';
  else if(env.XIAOZI_LLM_MODEL.trim().length>200)configReason='小紫模型名称配置无效';
  else{try{llmUrl=serviceUrl(env.XIAOZI_LLM_BASE_URL||'',env.XIAOZI_ALLOW_HTTP_LOOPBACK==='1');llmUrl.pathname=llmUrl.pathname.replace(/\/$/,'')+'/chat/completions';}catch{configReason='小紫服务地址配置无效';}}
  const model=env.XIAOZI_LLM_MODEL?.trim();
  const viewConversation=row=>({id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at});
  const viewMessage=row=>({id:row.id,role:row.role,content:row.content,status:row.status,clientId:row.client_id,createdAt:row.created_at});
  function own(id,userId){const row=db.prepare('SELECT * FROM ai_conversations WHERE id=? AND user_id=?').get(id,userId);if(!row)throw fail(404,'小紫会话不存在');return row;}
  function moduleView(def,userId){const member=platform.members[userId],configured=!!platform.modules[def.id],allowed=!!member?.modules.includes(def.id);return {...def,status:configured?(allowed?'connected':'forbidden'):'unconfigured',message:!configured?'尚未接入企业平台接口':!allowed?'请由企业管理员授权后访问':'已接入，可查询业务平台',capabilities:{query:configured&&allowed,control:false,approval:false}};}
  async function limitedJson(response,maxBytes){
    if(Number(response.headers.get('content-length'))>maxBytes)throw fail(502,'平台返回内容过大，请缩小查询范围');
    if(!response.body)throw fail(502,'平台未返回有效数据');
    const reader=response.body.getReader();let total=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes)throw fail(502,'平台返回内容过大，请缩小查询范围');chunks.push(value);}return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));}catch(error){await reader.cancel().catch(()=>{});if(error.status)throw error;throw fail(502,'平台返回格式不正确，请联系管理员');}finally{reader.releaseLock();}
  }
  async function queryPlatform(req,res,url,user,token,id){
    const def=moduleDefinitions.find(m=>m.id===id);if(!def)throw fail(404,'企业模块不存在');
    const connection=platform.modules[id];if(!connection)throw fail(503,'该模块尚未接入企业平台接口');
    if(!platform.members[user.id]?.modules.includes(id))throw fail(403,'你尚未获得该企业模块的访问权限');
    const query=url.searchParams.get('q')||'';if(query.length>500)throw fail(400,'查询内容不能超过 500 个字');
    rateLimit(req,'enterprise-query',30,60000,user.id);const target=new URL(connection.url);if(query)target.searchParams.set(connection.queryParameter,query);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000),close=()=>{if(!res.writableEnded)controller.abort();};res.once('close',close);let status='failed';
    try{
      const response=await fetchImpl(target,{method:'GET',headers:{Accept:'application/json',...(connection.token?{Authorization:'Bearer '+connection.token}:{})},signal:controller.signal,redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw fail(502,'企业平台查询失败，请稍后重试或联系管理员');}
      const data=await limitedJson(response,512*1024);requireSession(token);status='success';json(res,200,{moduleId:id,updatedAt:nowISO(),data});
    }catch(error){if(error.status)throw error;throw fail(502,controller.signal.aborted?'企业平台查询超时或已取消':'企业平台暂时无法连接');}
    finally{controller.abort();clearTimeout(timeout);res.off('close',close);db.prepare('INSERT INTO enterprise_query_audit(id,user_id,module_id,status,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),user.id,id,status,nowISO());}
  }
  async function answer(req,res,user,token,conversation,input){
    if(res.destroyed||req.aborted)return;
    if(configReason)throw fail(503,configReason);
    const content=typeof input.content==='string'?input.content.trim():'';
    if(!content||content.length>maxInput)throw fail(400,`提问需为 1–${maxInput} 个字`);
    const clientId=input.clientId;if(typeof clientId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(clientId))throw fail(400,'请提供有效的消息标识');
    if(active.has(conversation.id)||activeUsers.has(user.id))throw fail(409,'小紫正在回答，请先停止或等待当前回答');
    rateLimit(req,'ai-answer',10,60000,user.id);
    let userMessage=db.prepare("SELECT * FROM ai_messages WHERE conversation_id=? AND client_id=? AND role='user'").get(conversation.id,clientId);
    let assistant=db.prepare("SELECT * FROM ai_messages WHERE conversation_id=? AND client_id=? AND role='assistant'").get(conversation.id,clientId);
    if(userMessage){
      if(userMessage.content!==content)throw fail(409,'消息标识已用于其他提问');
      if(assistant.status!=='complete'){
        const last=db.prepare('SELECT client_id FROM ai_messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1').get(conversation.id);
        if(input.retry!==true||last.client_id!==clientId)throw fail(409,'只能重试最后一次未完成的回答');
      }
    }else{
      if(input.retry===true)throw fail(404,'需要重试的提问不存在');
      if(db.prepare("SELECT count(*) AS n FROM ai_messages WHERE conversation_id=? AND role='user'").get(conversation.id).n>=maxTurns)throw fail(409,'本会话已达 100 轮，请新建对话');
      const now=nowISO();
      transaction(()=>{
        db.prepare("INSERT INTO ai_messages(id,conversation_id,role,content,status,client_id,created_at,updated_at) VALUES(?,?,'user',?,'complete',?,?,?)").run(randomUUID(),conversation.id,content,clientId,now,now);
        db.prepare("INSERT INTO ai_messages(id,conversation_id,role,content,status,client_id,created_at,updated_at) VALUES(?,?,'assistant','','streaming',?,?,?)").run(randomUUID(),conversation.id,clientId,now,now);
        db.prepare('UPDATE ai_conversations SET title=?,updated_at=? WHERE id=?').run(conversation.title==='新对话'?content.slice(0,30):conversation.title,now,conversation.id);
      });
      userMessage=db.prepare("SELECT * FROM ai_messages WHERE conversation_id=? AND client_id=? AND role='user'").get(conversation.id,clientId);
      assistant=db.prepare("SELECT * FROM ai_messages WHERE conversation_id=? AND client_id=? AND role='assistant'").get(conversation.id,clientId);
    }
    const controller=new AbortController();active.set(conversation.id,controller);activeUsers.set(user.id,controller);
    let output='',finished=false,stopped=false,timeoutFired=false,sessionRevoked=false;
    const close=()=>{if(!res.writableEnded){stopped=true;controller.abort();}};res.once('close',close);
    const timeout=setTimeout(()=>{timeoutFired=true;controller.abort();},120000);
    const authTimer=setInterval(()=>{try{requireSession(token);}catch{sessionRevoked=true;controller.abort();}},1000);authTimer.unref();
    const emit=(event,data)=>{if(!res.destroyed&&!res.writableEnded){if(res.writableLength>256*1024){controller.abort();throw fail(502,'接收速度过慢，请重新连接');}res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}};
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    emit('meta',{conversationId:conversation.id,userMessage:viewMessage(userMessage),assistantMessageId:assistant.id});
    const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},10000);heartbeat.unref();
    try{
      if(assistant.status==='complete'){
        output=assistant.content;emit('delta',{text:output});finished=true;
      }else{
        db.prepare("UPDATE ai_messages SET content='',status='streaming',updated_at=? WHERE id=?").run(nowISO(),assistant.id);
        const previous=db.prepare("SELECT u.content AS question,a.content AS answer FROM ai_messages u JOIN ai_messages a ON u.conversation_id=a.conversation_id AND u.client_id=a.client_id AND a.role='assistant' WHERE u.conversation_id=? AND u.role='user' AND a.status='complete' AND u.seq<? ORDER BY u.seq DESC LIMIT 30").all(conversation.id,userMessage.seq).reverse();
        const context=[];let budget=60000;for(let i=previous.length-1;i>=0;i--){const pair=previous[i];if(pair.question.length+pair.answer.length>budget)break;context.unshift({role:'user',content:pair.question},{role:'assistant',content:pair.answer});budget-=pair.question.length+pair.answer.length;}
        requireSession(token);
        const response=await fetchImpl(llmUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.XIAOZI_LLM_API_KEY,Accept:'text/event-stream'},body:JSON.stringify({model,stream:true,messages:[{role:'system',content:'你是小紫，小紫在应用中的 AI 助手，帮助用户理解能源业务、整理资料和日常交流。用清楚简洁的中文回答。你没有直接连接企业数据库或设备；没有提供的实时数据、内部文档或审批结果请明确说明，不能编造，也不能声称已执行设备控制或审批。'},...context,{role:'user',content}],max_tokens:4096}),signal:controller.signal,redirect:'error'});
        if(!response.ok){await response.body?.cancel();throw fail(502,response.status===401?'小紫服务密钥无效，请联系管理员检查配置':response.status===403?'当前密钥无权访问该模型，请联系管理员授权':response.status===429?'小紫服务繁忙，请稍后重试':'小紫服务暂时不可用，请稍后重试');}
        const add=text=>{if(typeof text!=='string'||!text)return;requireSession(token);output+=text;if(output.length>maxOutput)throw fail(502,'回答超过长度限制，请缩小问题范围');emit('delta',{text});};
        if((response.headers.get('content-type')||'').includes('application/json')){
          const data=await limitedJson(response,1024*1024);const text=data.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw fail(502,'模型没有返回文本，请重试');add(text);finished=true;
        }else{
          if(!response.body)throw fail(502,'小紫服务没有返回内容');
          const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',total=0,sawFinal=false;
          const consume=frame=>{const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return;if(data==='[DONE]'){sawFinal=true;return;}let item;try{item=JSON.parse(data);}catch{throw fail(502,'小紫服务返回内容格式不正确');}if(item.error)throw fail(502,'小紫服务返回错误，请稍后重试');const choice=item.choices?.[0];add(choice?.delta?.content);if(choice?.finish_reason)sawFinal=true;};
          try{
            while(true){
              const {done,value}=await reader.read();if(done)break;
              total+=value.byteLength;if(total>1024*1024)throw fail(502,'模型返回内容过大');
              buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');if(buffer.length>128*1024)throw fail(502,'模型数据帧过大');
              let split;
              while(!sawFinal&&(split=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,split));buffer=buffer.slice(split+2);}
              if(sawFinal){await reader.cancel();break;}
            }
            // finish_reason is already terminal. A network chunk may also contain
            // an incomplete optional [DONE] trailer; do not parse it as JSON.
            if(!sawFinal){buffer+=decoder.decode();if(buffer.trim())consume(buffer);}
            if(!sawFinal||!output.trim())throw fail(502,'回答中断或没有返回文本，请重试');finished=true;
          }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        }
      }
      requireSession(token);const now=nowISO();db.prepare("UPDATE ai_messages SET content=?,status='complete',updated_at=? WHERE id=?").run(output,now,assistant.id);db.prepare('UPDATE ai_conversations SET updated_at=? WHERE id=?').run(now,conversation.id);
      emit('done',{message:viewMessage(db.prepare('SELECT * FROM ai_messages WHERE id=?').get(assistant.id)),conversation:viewConversation(own(conversation.id,user.id))});
    }catch(error){
      finished=false;const status=stopped?'stopped':'failed';db.prepare('UPDATE ai_messages SET content=?,status=?,updated_at=? WHERE id=?').run(output,status,nowISO(),assistant.id);
      if(!stopped)emit('error',{message:sessionRevoked?'登录已过期，请重新登录':timeoutFired?'小紫回答超时，请重试':error.status?error.message:'小紫暂时无法连接，请稍后重试',code:sessionRevoked?'SESSION_EXPIRED':timeoutFired?'TIMEOUT':'UPSTREAM_ERROR',retryable:!sessionRevoked});
    }finally{
      controller.abort();clearTimeout(timeout);clearInterval(authTimer);clearInterval(heartbeat);res.off('close',close);active.delete(conversation.id);activeUsers.delete(user.id);if(!res.writableEnded)res.end();
    }
  }
  return {
    close(){for(const controller of active.values())controller.abort();},
    async handle(req,res,url,user,token){
      const route=url.pathname;
      if(route==='/api/ai/status'&&req.method==='GET'){json(res,200,{configured:!configReason,reason:configReason||'小紫模型已配置',...(!configReason?{model}:{}),limits:{inputChars:maxInput,outputChars:maxOutput,turns:maxTurns}});return true;}
      if(route==='/api/enterprise/workspace'&&req.method==='GET'){const modules=moduleDefinitions.map(def=>moduleView(def,user.id));json(res,200,{organization:platform.members[user.id]?platform.organization:null,role:platform.members[user.id]?.role||null,modules,connectedCount:modules.filter(m=>m.status==='connected').length});return true;}
      const enterpriseRoute=route.match(/^\/api\/enterprise\/modules\/([a-z]+)(?:\/(control|approval))?$/);
      if(enterpriseRoute){if(enterpriseRoute[2])throw fail(403,'设备控制和审批尚未开通，请先配置企业角色与业务接口');if(req.method!=='GET')throw fail(405,'企业平台当前仅支持只读查询');await queryPlatform(req,res,url,user,token,enterpriseRoute[1]);return true;}
      if(route==='/api/ai/conversations'){
        if(req.method==='GET'){json(res,200,{conversations:db.prepare('SELECT * FROM ai_conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(user.id).map(viewConversation)});return true;}
        if(req.method==='POST'){rateLimit(req,'ai-conversation',20,60000,user.id);const input=await body(req);user=requireSession(token);if(db.prepare('SELECT count(*) AS n FROM ai_conversations WHERE user_id=?').get(user.id).n>=100)throw fail(409,'最多保留 100 个小紫会话，请先删除不需要的会话');const title=input.title===undefined?'新对话':typeof input.title==='string'?input.title.trim():'';if(!title||title.length>60)throw fail(400,'会话标题需为 1–60 个字');const id=randomUUID(),now=nowISO();db.prepare('INSERT INTO ai_conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,user.id,title,now,now);json(res,201,{conversation:viewConversation(own(id,user.id))});return true;}
      }
      const match=route.match(/^\/api\/ai\/conversations\/([a-zA-Z0-9-]{1,80})(?:\/(messages))?$/);
      if(match){
        let conversation=own(match[1],user.id);
        if(!match[2]&&req.method==='GET'){json(res,200,{conversation:viewConversation(conversation),messages:db.prepare('SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY seq').all(conversation.id).map(viewMessage)});return true;}
        if(!match[2]&&req.method==='DELETE'){if(active.has(conversation.id))throw fail(409,'请先停止当前回答再删除会话');db.prepare('DELETE FROM ai_conversations WHERE id=? AND user_id=?').run(conversation.id,user.id);json(res,200,{ok:true});return true;}
        if(match[2]==='messages'&&req.method==='POST'){const input=await body(req,32768);user=requireSession(token);conversation=own(conversation.id,user.id);await answer(req,res,user,token,conversation,input);return true;}
      }
      return false;
    }
  };
}
