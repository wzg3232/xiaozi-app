import {renderBusinessData,renderKnowledgeDocument} from './enterprise-data.js';
import {createWorkflowCenter} from './workflows.js';
import {attachChatViewport} from './chat-viewport.js';

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const svg=path=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const glyph={spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',plus:'M12 5v14M5 12h14',history:'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',send:'m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13',stop:'M6 6h12v12H6z',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',retry:'M20 7v5h-5M20 12a8 8 0 1 0-2 5',arrow:'m9 5 7 7-7 7',back:'m15 5-7 7 7 7',close:'M6 6l12 12M6 18 18 6',energy:'m13 2-9 12h7l-1 8 10-13h-8l1-7',price:'M3 18h18M5 14l4-4 4 2 6-8M15 4h4v4',book:'M12 5v16M3 3l9 2 9-2v16l-9 2-9-2V3',project:'M3 5h7l2 2h9v13H3V5M7 12h10M7 16h6',shield:'M12 2 4 6v6c0 5 8 10 8 10s8-5 8-10V6l-8-4m-4 10 3 3 5-6',query:'m21 21-5-5M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0'};
const ico=name=>svg(glyph[name]||glyph.project);
const suggestions=['帮我整理本周能源项目的工作重点','解释一下峰谷电价与储能收益的关系','把一段技术材料整理成汇报提纲','设计一个光伏电站巡检检查清单'];
const moduleDefaults=[
  {id:'energy',title:'能源管理',description:'用能、发电与储能运行信息',icon:'energy'},
  {id:'prices',title:'电价预测',description:'电价查询、预测结果与分析',icon:'price'},
  {id:'knowledge',title:'知识库',description:'技术资料、制度与经验沉淀',icon:'book'},
  {id:'projects',title:'项目进度',description:'项目节点、任务与交付记录',icon:'project'}
];
const statusLabels={connected:'已接入',forbidden:'暂无权限',unconfigured:'等待接入'};

// Incremental UTF-8/SSE decoding is kept independent of rendering and tested
// against split multibyte characters, split delimiters and multiline data.
export async function* readSseEvents(body,{signal,maxBuffer=1024*1024}={}){
  if(!body?.getReader)throw Error('当前设备无法读取流式回复，请更新系统 WebView');
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
  function parse(block){
    let event='message';const lines=[];
    for(const line of block.split(/\r?\n/)){
      if(line.startsWith('event:'))event=line.slice(6).trim();
      else if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''));
    }
    if(!lines.length)return null;
    const raw=lines.join('\n');if(raw==='[DONE]')return {event:'done',data:{}};
    let data;try{data=JSON.parse(raw);}catch{throw Error('回复数据格式不正确，请重试');}
    return {event,data};
  }
  try{
    while(true){
      if(signal?.aborted)throw new DOMException('已停止','AbortError');
      const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      if(buffer.length>maxBuffer)throw Error('回复数据超出大小限制');
      let match;while((match=/\r?\n\r?\n/.exec(buffer))){if(signal?.aborted)throw new DOMException('已停止','AbortError');const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);const item=parse(block);if(item)yield item;}
      if(done){if(buffer.trim()){const item=parse(buffer);if(item)yield item;}break;}
    }
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}

export function normalizeEnterpriseModules(workspace){
  const actual=Array.isArray(workspace?.modules)?workspace.modules:[];
  return moduleDefaults.map(fallback=>{
    const item=actual.find(m=>m.id===fallback.id||m.title===fallback.title)||{};
    const status=Object.hasOwn(statusLabels,item.status)?item.status:'unconfigured';
    return {...fallback,...item,id:item.id||fallback.id,demoId:fallback.id,icon:fallback.icon,status,capabilities:{query:status==='connected'&&item.capabilities?.query===true,control:false,approval:false},message:item.message||(status==='forbidden'?'当前账号尚未获得该模块权限':'接入企业系统后查看真实业务数据')};
  });
}

export function createEnterprisePage({host,tab,api,post,getSession,isCurrent=()=>true,notify=()=>{},openCollaboration=()=>{},fetch:request=window.fetch.bind(window),window:win=window}){
  const page=host.ownerDocument.createElement('section');page.className='enterprise-root';page.setAttribute('aria-label',tab==='xiaozi'?'小紫智能助手':'企业管理工作台');host.append(page);
  let disposed=false,epoch=0,requestGeneration=0,viewport=null,abort=null,conversationId=null,conversations=[],messages=[],aiStatus=null,draft='',busy=false,lastRequest=null,pendingDelete=null,historyOpen=false,loadingConversation=false,workspace=null,selectedModule=null,workflowPage=null,dataMode=null,lastBusinessResult=null;
  const current=()=>!disposed&&page.isConnected&&isCurrent();
  const dom=selector=>page.querySelector(selector);
  const status=message=>{if(current()){const node=dom('.ai-stream-status');if(node)node.textContent=message;}};
  const prettyDate=value=>{try{return new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(new Date(value));}catch{return '';}};
  function safeError(error){return typeof error?.message==='string'?error.message:'暂时无法完成操作，请重试';}
  function followIfNear(callback){const scroller=dom('.ai-messages'),follow=scroller&&scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<150;callback();if(follow)scroller.scrollTop=scroller.scrollHeight;}
  function setBusy(value){
    busy=value;const send=dom('#ai-send'),stop=dom('[data-ai="stop"]'),input=dom('#ai-input');
    if(send)send.hidden=value;if(stop)stop.hidden=!value;
    if(input)input.setAttribute('aria-describedby','ai-input-help');
    page.querySelectorAll('[data-ai="retry"]').forEach(b=>b.disabled=value);
  }
  function mountAi(){
    page.innerHTML=`<aside class="ai-history" aria-label="小紫会话历史"><div class="ai-history-heading"><span>${ico('history')}会话历史</span><button class="enterprise-icon history-close" data-ai="history-close" aria-label="关闭会话历史">${ico('close')}</button></div><button class="ai-new" data-ai="new">${ico('plus')}新建对话</button><div class="ai-history-list" aria-live="polite"><p class="enterprise-loading">正在读取会话…</p></div></aside><div class="ai-history-scrim" data-ai="history-close" hidden></div><section class="ai-main"><header class="enterprise-header"><div class="enterprise-heading"><img src="./assets/brand-flower.png" alt="" width="32" height="32"><div><h1>小紫</h1><p>你的能源工作伙伴</p></div></div><div class="enterprise-header-actions"><button class="enterprise-icon history-toggle" data-ai="history" aria-label="会话历史">${ico('history')}</button><button class="enterprise-icon" data-ai="new" aria-label="新建小紫对话">${ico('plus')}</button></div></header><div class="ai-config-note" role="status" hidden></div><div class="ai-messages" id="ai-messages" aria-label="与小紫的对话"></div><div class="ai-composer-wrap"><div class="ai-stream-status" role="status" aria-live="polite"></div><form class="ai-composer" id="ai-form"><label class="sr-only" for="ai-input">向小紫提问</label><textarea id="ai-input" placeholder="把问题交给小紫…" rows="2" maxlength="8000"></textarea><div class="ai-composer-bottom"><button class="ai-send" id="ai-send" type="submit" aria-label="发送给小紫">${ico('send')}</button><button class="ai-stop" type="button" data-ai="stop" aria-label="停止生成" hidden>${ico('stop')}停止</button></div></form></div></section>`;
      paintMessages();
    dom('#ai-form').addEventListener('submit',event=>{event.preventDefault();sendPrompt().catch(error=>notify(safeError(error)));});
    dom('#ai-input').addEventListener('input',event=>{draft=event.target.value;});
    dom('#ai-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!busy)sendPrompt().catch(error=>notify(safeError(error)));}});
    const shell=page.closest('.app-shell');if(shell)viewport=attachChatViewport({shell,messages:dom('#ai-messages'),input:dom('#ai-input'),sendButton:dom('#ai-send'),window:win});
    page.addEventListener('click',onAiClick);
    Promise.allSettled([loadHistory(),loadStatus()]).then(()=>{});
  }
  async function loadStatus(){
    try{const result=await api('/api/ai/status');if(!current())return;aiStatus=result;const note=dom('.ai-config-note');if(!result.configured){note.hidden=false;note.textContent=result.reason||'小紫暂未连接模型，请联系管理员完成配置';}else{note.hidden=true;dom('.enterprise-heading p').textContent='随时提问，和小紫一起解决';}}
    catch(error){if(current()){dom('.ai-config-note').hidden=false;dom('.ai-config-note').textContent='暂时无法连接小紫服务，可稍后重试';}}
  }
  async function loadHistory(){
    try{const result=await api('/api/ai/conversations');if(!current())return;conversations=result.conversations||[];paintHistory();}
    catch(error){if(current())dom('.ai-history-list').innerHTML=`<p class="enterprise-inline-error">${escapeHtml(safeError(error))}</p><button class="enterprise-link" data-ai="history-retry">重新读取</button>`;}
  }
  function paintHistory(){
    if(!current())return;
    dom('.ai-history-list').innerHTML=conversations.length?conversations.map(c=>`<div class="ai-history-row ${c.id===conversationId?'selected':''}"><button class="ai-history-open" data-ai="open" data-id="${escapeHtml(c.id)}"><span>${escapeHtml(c.title||'新的对话')}</span><small>${prettyDate(c.updatedAt||c.createdAt)}</small></button><button class="enterprise-icon ai-history-delete" data-ai="delete-ask" data-id="${escapeHtml(c.id)}" aria-label="删除对话 ${escapeHtml(c.title||'新的对话')}">${ico('trash')}</button>${pendingDelete===c.id?`<div class="ai-delete-confirm"><span>删除这段对话？</span><button data-ai="delete" data-id="${escapeHtml(c.id)}">删除</button><button data-ai="delete-cancel">取消</button></div>`:''}</div>`).join(''):'<div class="ai-history-empty">新的想法，从一次提问开始。<br>你的对话会显示在这里。</div>';
  }
  function paintMessages(forceFollow=true){
    if(!current())return;
    const scroller=dom('.ai-messages'),oldTop=scroller.scrollTop,follow=forceFollow||scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<150;
    if(!messages.length){scroller.innerHTML=`<div class="ai-empty"><div class="ai-empty-mark"><img src="./assets/brand-flower.png" alt="" width="65" height="65"></div><p class="ai-eyebrow">你好，我是小紫</p><h2>一起把问题，<br>变成清晰的答案。</h2><div class="ai-suggestions">${suggestions.map((text,i)=>`<button data-ai="suggest" data-index="${i}">${ico(i===1?'price':i===3?'energy':'spark')}<span>${text}</span>${ico('arrow')}</button>`).join('')}</div></div>`;return;}
    scroller.innerHTML=messages.map((m,index)=>`<article class="ai-message ${m.role==='user'?'from-user':'from-assistant'}" data-message-index="${index}"><div class="ai-message-author">${m.role==='user'?'<span class="ai-user-avatar">我</span>':'<img src="./assets/brand-flower.png" alt="" width="25" height="25">'}<b>${m.role==='user'?'你':'小紫'}</b></div><div class="ai-message-body">${escapeHtml(m.content||'')}</div>${m.role==='assistant'&&['stopped','failed','error'].includes(m.status)?`<p class="ai-message-state">${m.status==='stopped'?'已停止生成':'本次回复未完成'}</p>`:''}${index===messages.length-1&&m.role==='assistant'&&['stopped','failed','error'].includes(m.status)&&lastRequest&&!busy?`<button class="ai-retry" data-ai="retry">${ico('retry')}重新生成</button>`:''}</article>`).join('');
    if(follow){scroller.scrollTop=scroller.scrollHeight;viewport?.followLatest();}else{scroller.scrollTop=oldTop;viewport?.rememberPosition();}
  }
  async function openConversation(id){
    const generation=++epoch;stop();loadingConversation=true;dom('#ai-send').disabled=true;status('正在读取对话…');
    try{const result=await api('/api/ai/conversations/'+encodeURIComponent(id));if(!current()||generation!==epoch)return;
      conversationId=result.conversation.id;messages=result.messages||[];lastRequest=null;
      const user=[...messages].reverse().find(m=>m.role==='user');if(user?.clientId)lastRequest={content:user.content,clientId:user.clientId};
      draft='';dom('#ai-input').value='';status('');setHistory(false);paintHistory();paintMessages();
    }catch(error){if(current()&&generation===epoch){status(safeError(error));notify(safeError(error));}}
    finally{if(current()&&generation===epoch){loadingConversation=false;dom('#ai-send').disabled=false;}}
  }
  function setHistory(value){historyOpen=value;page.classList.toggle('history-open',value);const scrim=dom('.ai-history-scrim');if(scrim)scrim.hidden=!value;}
  function newConversation(){epoch++;stop(false);loadingConversation=false;dom('#ai-send').disabled=false;conversationId=null;messages=[];lastRequest=null;draft='';dom('#ai-input').value='';status('');setHistory(false);paintHistory();paintMessages();}
  function stop(mark=true){requestGeneration++;if(abort){abort.abort();abort=null;}if(mark&&busy){const last=messages.at(-1);if(last?.role==='assistant')last.status='stopped';}if(busy){setBusy(false);if(mark){status('已停止，可继续提问或重新生成');paintMessages(false);}}}
  async function sendPrompt(retry=false){
    if(busy||loadingConversation||!current())return;
    const input=dom('#ai-input'),content=retry?lastRequest?.content:input.value.trim();
    if(!content)return;
    if(aiStatus?.configured===false){status(aiStatus.reason||'小紫的模型尚未配置，请联系管理员');return;}
    if(content.length>(aiStatus?.limits?.inputChars||8000)){status('问题过长，请分成几段发送');return;}
    const generation=epoch,requestId=++requestGeneration,session=getSession();let creating=false;
    const activeRequest=()=>current()&&generation===epoch&&requestId===requestGeneration;
    setBusy(true);status('小紫正在思考…');
    const controller=new AbortController();abort=controller;
    const payload=retry?{...lastRequest,retry:true}:{content,clientId:win.crypto.randomUUID()};lastRequest={content:payload.content,clientId:payload.clientId};
    try{
      if(!conversationId){creating=true;const result=await post('/api/ai/conversations',{});if(!activeRequest()||controller.signal.aborted)return;conversationId=result.conversation.id;conversations.unshift(result.conversation);paintHistory();}
      if(!retry){messages.push({role:'user',content,status:'complete',clientId:payload.clientId});input.value='';draft='';}
      else if(messages.at(-1)?.role==='assistant')messages.pop();
      messages.push({role:'assistant',content:'',status:'streaming'});paintMessages();const assistant=messages.at(-1);
      const response=await request(session.base+'/api/ai/conversations/'+encodeURIComponent(conversationId)+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.token},body:JSON.stringify(payload),signal:controller.signal});
      if(!response.ok){let detail;try{detail=await response.json();}catch{}throw Error(detail?.error||'小紫暂时无法回答，请稍后重试');}
      let completed=false;
      for await(const {event,data}of readSseEvents(response.body,{signal:controller.signal})){
        if(!activeRequest()||controller.signal.aborted)return;
        if(event==='meta'){if(data.assistantMessageId)assistant.id=data.assistantMessageId;if(data.userMessage&&messages.length>=2)messages[messages.length-2]={...messages[messages.length-2],...data.userMessage};}
        else if(event==='delta'&&typeof data.text==='string'){
          assistant.content+=data.text;followIfNear(()=>{const node=dom('.ai-message:last-child .ai-message-body');if(node)node.textContent=assistant.content;});status('小紫正在回答…');
        }else if(event==='error'){assistant.status='failed';throw Error(data.message||'回复中断，请重试');}
        else if(event==='done'){completed=true;if(data.message)Object.assign(assistant,data.message);assistant.status=assistant.status==='streaming'?'complete':assistant.status;
          if(data.conversation){const i=conversations.findIndex(c=>c.id===data.conversation.id);if(i>=0)conversations[i]=data.conversation;else conversations.unshift(data.conversation);}status('');}
      }
      if(!completed)throw Error('连接已中断，可重新生成本次回复');
    }catch(error){
      if(!activeRequest())return;
      const assistant=messages.at(-1);if(assistant?.role==='assistant')assistant.status=controller.signal.aborted?'stopped':'failed';
      status(controller.signal.aborted?'已停止，可继续提问或重新生成':safeError(error));
      if(creating&&messages.length===0)draft=input.value;
    }finally{
      if(abort===controller)abort=null;
      if(activeRequest()){setBusy(false);paintHistory();paintMessages(false);}
    }
  }
  async function onAiClick(event){
    const target=event.target.closest('[data-ai]');if(!target||!page.contains(target))return;
    const action=target.dataset.ai;
    try{
      if(action==='history')setHistory(!historyOpen);else if(action==='history-close')setHistory(false);
      else if(action==='new')newConversation();else if(action==='open')await openConversation(target.dataset.id);
      else if(action==='history-retry')await loadHistory();else if(action==='retry')await sendPrompt(true);else if(action==='stop')stop();
      else if(action==='suggest'){const text=suggestions[Number(target.dataset.index)];if(text&&!busy){dom('#ai-input').value=text;draft=text;await sendPrompt();}}
      else if(action==='delete-ask'){pendingDelete=target.dataset.id;paintHistory();}else if(action==='delete-cancel'){pendingDelete=null;paintHistory();}
      else if(action==='delete'){
        const id=target.dataset.id;target.disabled=true;await api('/api/ai/conversations/'+encodeURIComponent(id),{method:'DELETE'});if(!current())return;
        conversations=conversations.filter(c=>c.id!==id);pendingDelete=null;if(conversationId===id)newConversation();else paintHistory();notify('这段小紫对话已删除');
      }
    }catch(error){if(current())notify(safeError(error));}
  }

  function mountManagement(){
    page.classList.add('management-root');
    page.innerHTML=`<header class="enterprise-header"><div class="enterprise-heading"><span class="management-symbol">${ico('project')}</span><div><h1>管理</h1><p>能源业务，一个工作台</p></div></div><button class="enterprise-icon" data-manage="refresh" aria-label="刷新工作台">${ico('retry')}</button></header><div class="management-scroll"><p class="enterprise-loading">正在读取工作台…</p></div>`;
    page.addEventListener('click',onManagementClick);loadWorkspace();
  }
  async function loadWorkspace(){
    try{const result=await api('/api/enterprise/workspace');if(!current())return;workspace=result;renderWorkspace();}
    catch(error){if(current())dom('.management-scroll').innerHTML=`<div class="enterprise-error-card"><h2>暂时无法读取工作台</h2><p>${escapeHtml(safeError(error))}</p><button class="button secondary" data-manage="refresh">重新读取</button></div>`;}
  }
  function renderWorkspace(){
    workflowPage?.destroy();workflowPage=null;
    selectedModule=null;const modules=normalizeEnterpriseModules(workspace);
    dom('.management-scroll').innerHTML=`<section class="workbench-welcome"><div><p>小紫在 · 企业工作台</p><h2>今天的工作，从这里开始。</h2></div><div class="workbench-welcome-art" aria-hidden="true">${ico('spark')}</div></section><section class="workbench-group"><div class="workbench-group-heading"><h3>能源业务</h3></div><div class="workbench-grid">${modules.map(m=>`<button class="workbench-tile" data-manage="module" data-id="${escapeHtml(m.id)}"><span class="workbench-tile-icon ${m.icon}">${ico(m.icon)}</span><b>${escapeHtml(m.title)}</b></button>`).join('')}</div></section><section class="workbench-group"><div class="workbench-group-heading"><h3>办公流程</h3><button class="enterprise-link" data-manage="workflow" data-list="mine">我的申请 ›</button></div><div class="workbench-grid">${[['leave','请假','☀'],['travel','出差','↗'],['expense','报销','¥'],['purchase','采购','▣']].map(([id,title,symbol])=>`<button class="workbench-tile" data-manage="workflow" data-template="${id}"><span class="workbench-tile-icon office-${id}" aria-hidden="true">${symbol}</span><b>${title}</b></button>`).join('')}</div><div class="workbench-workflow-shortcuts"><button data-manage="workflow" data-list="drafts">草稿箱<span>继续编辑 ›</span></button><button data-manage="workflow" data-list="reviews">待我处理<span>查看审批 ›</span></button></div></section><section class="workbench-group"><div class="workbench-group-heading"><h3>团队协同</h3></div><div class="workbench-grid collaboration-grid"><button class="workbench-tile" data-manage="collaboration" data-kind="moments"><span class="workbench-tile-icon collaboration-moments">${ico('spark')}</span><b>朋友圈</b></button><button class="workbench-tile" data-manage="collaboration" data-kind="favorites"><span class="workbench-tile-icon collaboration-favorites">${ico('book')}</span><b>我的收藏</b></button><button class="workbench-tile" data-manage="collaboration" data-kind="scan-code"><span class="workbench-tile-icon collaboration-scan">${ico('query')}</span><b>扫一扫</b></button><button class="workbench-tile" data-manage="collaboration" data-kind="my-code"><span class="workbench-tile-icon collaboration-code">${ico('project')}</span><b>我的二维码</b></button><button class="workbench-tile" data-manage="workflow" data-list="mine"><span class="workbench-tile-icon collaboration-process">${ico('project')}</span><b>流程中心</b></button><button class="workbench-tile" data-manage="control-info"><span class="workbench-tile-icon collaboration-control">${ico('shield')}</span><b>控制权限</b></button></div></section>`;

  }
  function renderModule(id){
    const module=normalizeEnterpriseModules(workspace).find(m=>m.id===id);if(!module)return;selectedModule=module;dataMode=module.capabilities.query?'enterprise':'demo';lastBusinessResult=null;
    const demo=dataMode==='demo',placeholder=module.demoId==='knowledge'?'搜索文档关键词，如“储能”':module.demoId==='projects'?'搜索项目名称或关键词':'输入查询关键词，或直接查询';
    dom('.management-scroll').innerHTML=`<button class="enterprise-back" data-manage="back">${ico('back')}工作台</button><section class="management-detail-head"><span class="module-icon ${module.icon}">${ico(module.icon)}</span><div><h2>${escapeHtml(module.title)}</h2><p>${escapeHtml(module.description)}</p></div></section><form class="enterprise-query"><label for="enterprise-query-input">业务查询</label><div><input id="enterprise-query-input" name="query" placeholder="${escapeHtml(placeholder)}" maxlength="${demo?120:500}"><button class="button" type="submit">查询</button></div></form><section class="enterprise-query-result" aria-live="polite"><p class="enterprise-loading">正在读取数据…</p></section>`;
    dom('.management-scroll').scrollTop=0;
    dom('.enterprise-query').addEventListener('submit',queryModule);
    queryModule();
  }
  function paintBusinessResult(){
    if(!current()||!lastBusinessResult||!selectedModule)return;
    const result=lastBusinessResult,panel=dom('.enterprise-query-result');if(!panel)return;
    const date=dataMode==='demo'?result.meta?.sampleDate:result.updatedAt;
    panel.innerHTML=(date?`<p class="enterprise-query-time">数据日期：${escapeHtml(date)}</p>`:'')+renderBusinessData(result,{moduleId:selectedModule.demoId,mode:dataMode});
  }
  async function queryModule(event){
    event?.preventDefault();const module=selectedModule,mode=dataMode;if(!module||!(mode==='demo'||module.capabilities.query))return;
    const input=dom('#enterprise-query-input'),q=input.value.trim();
    const generation=++epoch,button=dom('.enterprise-query button');button.disabled=true;dom('.enterprise-query-result').textContent='正在读取数据…';
    try{
      const prefix=mode==='demo'?'/api/enterprise/demo/modules/':'/api/enterprise/modules/';
      const result=await api(prefix+encodeURIComponent(mode==='demo'?module.demoId:module.id)+'?q='+encodeURIComponent(q));if(!current()||generation!==epoch||selectedModule?.id!==module.id||dataMode!==mode)return;
      if(mode==='demo'&&(result.isDemo!==true||result.mode!=='demo'))throw Error('数据格式不正确，请稍后重试');
      if(mode!=='demo'&&result.isDemo===true)throw Error('数据来源不匹配，请联系管理员');
      lastBusinessResult=result;paintBusinessResult();
    }catch(error){if(current()&&generation===epoch){lastBusinessResult=null;dom('.enterprise-query-result').textContent=safeError(error);}}
    finally{if(current()&&generation===epoch)button.disabled=false;}
  }
  async function onManagementClick(event){const button=event.target.closest('[data-manage]');if(!button)return;const action=button.dataset.manage;
    if(action==='document'){const document=(lastBusinessResult?.data?.documents||[]).find(item=>item.id===button.dataset.document);if(document){dom('.enterprise-query-result').innerHTML='<button class="enterprise-back" data-manage="document-back">‹ 返回查询结果</button>'+renderKnowledgeDocument(document,{mode:dataMode});}}
    else if(action==='document-back')paintBusinessResult();
    else if(action==='workflow'){epoch++;workflowPage?.destroy();workflowPage=createWorkflowCenter({host:dom('.management-scroll'),api,post,notify,isCurrent:current,onBack:renderWorkspace});workflowPage.open({templateId:button.dataset.template||null,list:button.dataset.list||'drafts'});}
    else if(action==='collaboration'){const kind=button.dataset.kind;if(['moments','favorites','scan-code','my-code'].includes(kind))openCollaboration(kind);}
    else if(action==='control-info'){dom('.management-scroll').innerHTML=`<button class="enterprise-back" data-manage="back">${ico('back')}工作台</button><div class="management-unavailable"><span>${ico('shield')}</span><h2>设备控制未开通</h2><button class="button secondary" data-manage="back">返回工作台</button></div>`;}
    else if(action==='refresh'){epoch++;workflowPage?.destroy();workflowPage=null;await loadWorkspace();}else if(action==='module'){epoch++;renderModule(button.dataset.id);}else if(action==='back'){epoch++;renderWorkspace();}
    else if(action==='entry'){
      if(button.dataset.kind==='query'){const modules=normalizeEnterpriseModules(workspace),first=modules.find(m=>m.capabilities.query)||modules[0];renderModule(first.id);}
      else{const approval=button.dataset.kind==='approval';dom('.management-scroll').innerHTML=`<button class="enterprise-back" data-manage="back">${ico('back')}工作台</button><div class="management-unavailable"><span>${ico(approval?'shield':'energy')}</span><h2>${approval?'审批流程尚未接入':'设备控制未开通'}</h2><button class="button secondary" data-manage="back">返回工作台</button></div>`;}
    }
  }
  if(tab==='xiaozi')mountAi();else mountManagement();
  return {tab,page,destroy(){if(disposed)return;disposed=true;epoch++;workflowPage?.destroy();workflowPage=null;abort?.abort();abort=null;viewport?.destroy();page.removeEventListener('click',onAiClick);page.removeEventListener('click',onManagementClick);page.remove();}};
}
