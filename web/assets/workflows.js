const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stateLabels={draft:'草稿',pending:'审批中',approved:'已通过',rejected:'已驳回'};
const typeHints={leave:'安排休假时间',travel:'规划出差行程',expense:'整理费用明细',purchase:'发起采购需求'};
const typeSymbols={leave:'☀',travel:'↗',expense:'¥',purchase:'▣'};
const auditLabels={created:'创建草稿',saved:'更新草稿',submitted:'提交申请',withdrawn:'撤回申请',approved:'审批通过',rejected:'审批驳回'};

export function workflowList(snapshot,view){
  if(view==='reviews')return (snapshot?.reviews||[]).filter(request=>request.status==='pending'&&request.canReview===true);
  return (snapshot?.requests||[]).filter(request=>view==='drafts'?request.status==='draft':request.status!=='draft');
}
export function collectWorkflowData(form,template,{requireAll=false}={}){
  const data={};
  for(const field of template.fields||[]){
    if(!/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.name))throw Error('申请字段配置不正确');
    const value=String(form.elements.namedItem(field.name)?.value??'').trim(),label=field.label||field.name;
    if(!value){if(requireAll&&field.required)throw Error('请填写'+label);continue;}
    if(field.maxLength&&value.length>field.maxLength)throw Error(label+'最多'+field.maxLength+'字');
    if(field.type==='number'){
      const number=Number(value);if(!Number.isFinite(number)||(field.min!==undefined&&number<field.min)||(field.max!==undefined&&number>field.max))throw Error('请填写有效的'+label);
      if(field.step===1&&!Number.isInteger(number))throw Error(label+'须为整数');
      if(field.step===.01&&Math.abs(number*100-Math.round(number*100))>1e-6)throw Error(label+'最多保留两位小数');
      data[field.name]=number;
    }else if(field.type==='date'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('请填写有效的'+label);
      data[field.name]=value;
    }else if(field.type==='select'){
      if(!(field.options||[]).some(option=>String(typeof option==='string'?option:option.value)===value))throw Error('请选择有效的'+label);
      data[field.name]=value;
    }else data[field.name]=value;
  }
  if(data.startDate&&data.endDate&&data.startDate>data.endDate)throw Error('结束日期不能早于开始日期');
  return data;
}

export function createWorkflowCenter({host,api,post,isCurrent=()=>true,notify=()=>{},onBack=()=>{}}){
  const section=host.ownerDocument.createElement('section');section.className='workflow-center';host.replaceChildren(section);
  let disposed=false,epoch=0,snapshot=null,view='drafts',selected=null,template=null,initialTemplate=null,working=false,detailAudit=[];
  const current=()=>!disposed&&section.isConnected&&isCurrent();
  const dom=selector=>section.querySelector(selector);
  const date=value=>{try{return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}catch{return '';}};
  const errorMessage=error=>error?.message||'暂时无法完成操作，请重试';
  function setError(message){const box=dom('.workflow-error');if(box){box.textContent=message;box.hidden=!message;}else notify(message);}
  function heading(title='流程中心'){
    return `<button type="button" class="enterprise-back" data-wf="back">‹ 返回管理</button><div class="workflow-title"><div><p>WORKFLOW CENTER</p><h2>${escapeHtml(title)}</h2></div><span class="workflow-title-mark">✓</span></div>`;
  }
  function updateRecord(request){
    if(!snapshot)return;
    const list=snapshot.requests||[];const index=list.findIndex(item=>item.id===request.id);
    if(index>=0)list[index]=request;else if(request.applicant?.id&&!request.canReview)list.unshift(request);
    snapshot.requests=list;snapshot.reviews=(snapshot.reviews||[]).filter(item=>item.id!==request.id||request.status==='pending');
  }
  async function load({openTemplate=null}={}){
    const generation=++epoch;section.innerHTML=heading()+'<p class="enterprise-loading">正在读取流程…</p>';
    try{const result=await api('/api/workflows');if(!current()||generation!==epoch)return;snapshot=result;if(openTemplate){const item=(snapshot.templates||[]).find(t=>t.id===openTemplate);if(item){renderForm(item);return;}}renderHome();}
    catch(error){if(current()&&generation===epoch)section.innerHTML=heading()+`<div class="workflow-error-card"><h3>暂时无法读取流程</h3><p>${escapeHtml(errorMessage(error))}</p><button class="button secondary" data-wf="refresh">重新读取</button></div>`;}
  }
  function renderHome(){
    epoch++;selected=null;template=null;working=false;detailAudit=[];
    const rows=workflowList(snapshot,view);
    section.innerHTML=heading()+`<div class="workflow-template-grid">${(snapshot.templates||[]).map(item=>`<button data-wf="template" data-template="${escapeHtml(item.id)}"><span class="workflow-template-icon type-${escapeHtml(item.id)}">${typeSymbols[item.id]||'▧'}</span><b>${escapeHtml(item.title)}</b></button>`).join('')}</div><div class="workflow-tabs" role="tablist" aria-label="申请列表">${[['drafts','草稿'],['mine','我的申请'],['reviews','待我处理']].map(([id,label])=>`<button role="tab" aria-selected="${view===id}" class="${view===id?'selected':''}" data-wf="view" data-view="${id}">${label}<small>${workflowList(snapshot,id).length}</small></button>`).join('')}</div><div class="workflow-request-list" role="tabpanel">${rows.map(request=>`<button class="workflow-request" data-wf="request" data-id="${escapeHtml(request.id)}"><span class="workflow-request-symbol type-${escapeHtml(request.templateId)}">${typeSymbols[request.templateId]||'▧'}</span><span class="workflow-request-copy"><b>${escapeHtml(request.title||'未命名申请')}</b><small>${escapeHtml(request.applicant?.displayName||'')}${request.updatedAt?' · '+date(request.updatedAt):''}</small></span><span class="workflow-status ${Object.hasOwn(stateLabels,request.status)?request.status:'draft'}">${stateLabels[request.status]||'待确认'}</span><span class="workflow-row-arrow">›</span></button>`).join('')||`<div class="workflow-empty"><span>${view==='reviews'?'✓':'▤'}</span><h3>${view==='drafts'?'还没有草稿':view==='reviews'?'暂无待处理申请':'还没有已提交的申请'}</h3></div>`}</div>`;
  }
  function fieldControl(field,value){
    const attrs=`id="wf-${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" aria-label="${escapeHtml(field.label||field.name)}"${field.maxLength?` maxlength="${Number(field.maxLength)}"`:''}`;
    if(field.type==='textarea')return `<textarea ${attrs} rows="4" placeholder="请填写${escapeHtml(field.label)}">${escapeHtml(value)}</textarea>`;
    if(field.type==='select')return `<select ${attrs}><option value="">请选择</option>${(field.options||[]).map(option=>{const optionValue=typeof option==='string'?option:option.value,label=typeof option==='string'?option:option.label;return `<option value="${escapeHtml(optionValue)}" ${String(value)===String(optionValue)?'selected':''}>${escapeHtml(label)}</option>`;}).join('')}</select>`;
    const type=['text','number','date'].includes(field.type)?field.type:'text';
    return `<div class="workflow-input-with-unit"><input ${attrs} type="${type}" value="${escapeHtml(value)}"${field.min!==undefined?` min="${Number(field.min)}"`:''}${field.max!==undefined?` max="${Number(field.max)}"`:''}${field.step!==undefined?` step="${Number(field.step)}"`:''}${type==='number'?' inputmode="decimal"':''} placeholder="请填写${escapeHtml(field.label)}">${field.unit?`<span>${escapeHtml(field.unit)}</span>`:''}</div>`;
  }
  function renderForm(item,request=null,audit=[]){
    epoch++;template=item;selected=request;detailAudit=audit;working=false;
    const editable=!request||request.canEdit===true;
    if(!editable){renderDetail();return;}
    section.innerHTML=heading(item.title)+`<button class="workflow-home-link" data-wf="home">‹ 流程中心</button><form class="workflow-form" novalidate><div class="workflow-fields">${(item.fields||[]).map(field=>`<label class="workflow-field ${field.type==='textarea'?'full-width':''}" for="wf-${escapeHtml(field.name)}"><span>${escapeHtml(field.label)}${field.required?'<small>必填</small>':''}</span>${fieldControl(field,request?.data?.[field.name]??'')}</label>`).join('')}</div><p class="workflow-error" role="alert" hidden></p><div class="workflow-form-actions"><button type="button" class="button secondary" data-wf="save">保存草稿</button><button type="submit" class="button" data-wf="submit">提交申请</button></div>${request?`<p class="workflow-saved-time">已保存 · ${date(request.updatedAt)}</p>`:''}</form>`;
    dom('.workflow-form').addEventListener('submit',event=>{event.preventDefault();save(true);});
  }
  function renderDetail(){
    const request=selected,item=template;const fields=item?.fields||[];
    section.innerHTML=heading(item?.title||'申请详情')+`<button class="workflow-home-link" data-wf="home">‹ 流程中心</button><div class="workflow-detail-title"><div><h3>${escapeHtml(request.title||item?.title||'申请')}</h3><p>${escapeHtml(request.applicant?.displayName||'')} · ${date(request.createdAt)}</p></div><span class="workflow-status ${Object.hasOwn(stateLabels,request.status)?request.status:'draft'}">${stateLabels[request.status]||'待确认'}</span></div><dl class="workflow-detail-fields">${fields.map(field=>`<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(request.data?.[field.name]??'未填写')}${field.unit&&request.data?.[field.name]!==undefined?' '+escapeHtml(field.unit):''}</dd></div>`).join('')}</dl><p class="workflow-error" role="alert" hidden></p><div class="workflow-detail-actions">${request.canWithdraw?'<button class="button secondary" data-wf="withdraw-ask">撤回申请</button>':''}${request.canReview?'<button class="button secondary" data-wf="review-ask" data-decision="reject">驳回</button><button class="button" data-wf="review-ask" data-decision="approve">同意申请</button>':''}</div><div class="workflow-confirm-slot"></div>${detailAudit.length?`<section class="workflow-audit"><h3>处理记录</h3>${detailAudit.map(record=>`<div><span></span><p><b>${escapeHtml(record.actionLabel||auditLabels[record.action]||'状态更新')}</b><small>${escapeHtml(record.actor?.displayName||record.actorName||'')} · ${date(record.createdAt)}</small>${record.comment||record.detail?.comment?`<em>${escapeHtml(record.comment||record.detail.comment)}</em>`:''}</p></div>`).join('')}</section>`:''}`;
  }
  function controlsDisabled(value){working=value;section.querySelectorAll('.workflow-form input,.workflow-form select,.workflow-form textarea,.workflow-form-actions button,.workflow-detail-actions button,.workflow-confirm button').forEach(element=>element.disabled=value);}
  async function save(submit=false){
    if(working||!current()||!template)return;
    const form=dom('.workflow-form');if(!form)return;
    let data;try{data=collectWorkflowData(form,template,{requireAll:submit});}catch(error){setError(errorMessage(error));return;}
    const generation=epoch,capturedTemplate=template;setError('');controlsDisabled(true);
    try{
      const result=selected?await post('/api/workflows/'+encodeURIComponent(selected.id)+'/save',{version:selected.version,data}):await post('/api/workflows',{templateId:template.id,data});
      if(!current()||generation!==epoch)return;selected=result.request;updateRecord(selected);
      if(!submit){renderForm(capturedTemplate,selected);notify('草稿已保存');return;}
      try{
        const submitted=await post('/api/workflows/'+encodeURIComponent(selected.id)+'/submit',{version:selected.version});
        if(!current()||generation!==epoch)return;selected=submitted.request;updateRecord(selected);notify('申请已提交');renderDetail();
      }catch(error){if(current()&&generation===epoch){const saved=selected;renderForm(capturedTemplate,saved);setError('草稿已保存，申请尚未提交：'+errorMessage(error));}}
    }catch(error){if(current()&&generation===epoch)setError(errorMessage(error));}
    finally{if(current()&&generation===epoch)controlsDisabled(false);}
  }
  async function openRequest(id){
    const generation=++epoch;section.innerHTML=heading('申请详情')+'<p class="enterprise-loading">正在读取申请…</p>';
    try{const result=await api('/api/workflows/'+encodeURIComponent(id));if(!current()||generation!==epoch)return;
      const item=(snapshot.templates||[]).find(t=>t.id===result.request.templateId);if(!item)throw Error('流程模板暂不可用，请刷新后重试');renderForm(item,result.request,result.audit||[]);
    }catch(error){if(current()&&generation===epoch)section.innerHTML=heading('申请详情')+`<p class="workflow-error">${escapeHtml(errorMessage(error))}</p><button class="button secondary" data-wf="home">返回流程中心</button>`;}
  }
  function showConfirmation(kind,decision){
    const slot=dom('.workflow-confirm-slot');if(!slot)return;
    if(kind==='review'&&!selected?.canReview)return;if(kind==='withdraw'&&!selected?.canWithdraw)return;
    const approval=decision==='approve';
    slot.innerHTML=`<section class="workflow-confirm"><h3>${kind==='withdraw'?'确认撤回这份申请？':approval?'确认同意这份申请？':'确认驳回这份申请？'}</h3><p>${kind==='withdraw'?'撤回后会返回草稿，可继续编辑。':'请核对申请内容，处理结果会记录在申请历史中。'}</p>${kind==='review'?'<label>处理意见（选填）<textarea id="workflow-review-comment" rows="3" maxlength="1000" placeholder="写下你的处理意见"></textarea></label>':''}<div><button class="button secondary" data-wf="confirm-cancel">取消</button><button class="button" data-wf="confirm" data-kind="${kind}" data-decision="${approval?'approve':'reject'}">确认${kind==='withdraw'?'撤回':approval?'同意':'驳回'}</button></div></section>`;
  }
  async function confirm(kind,decision){
    if(working||!selected||!current())return;if(kind==='review'&&!selected.canReview)return;if(kind==='withdraw'&&!selected.canWithdraw)return;
    const generation=epoch,id=selected.id,payload={version:selected.version};if(kind==='review'){payload.decision=decision;payload.comment=dom('#workflow-review-comment')?.value.trim()||'';}
    controlsDisabled(true);setError('');
    try{const result=await post('/api/workflows/'+encodeURIComponent(id)+'/'+(kind==='review'?'review':'withdraw'),payload);if(!current()||generation!==epoch)return;updateRecord(result.request);notify(kind==='review'?'申请已处理':'申请已撤回');await openRequest(id);}
    catch(error){if(current()&&generation===epoch)setError(errorMessage(error));}
    finally{if(current()&&generation===epoch)controlsDisabled(false);}
  }
  async function onClick(event){
    const button=event.target.closest('[data-wf]');if(!button||!section.contains(button))return;const action=button.dataset.wf;
    if(action==='submit')return;
    event.preventDefault();
    if(action==='back'){onBack();return;}
    if(action==='home'){load();return;}
    if(action==='refresh'){load({openTemplate:initialTemplate});return;}
    if(action==='view'){view=['drafts','mine','reviews'].includes(button.dataset.view)?button.dataset.view:'drafts';renderHome();}
    else if(action==='template'){const item=snapshot?.templates?.find(t=>t.id===button.dataset.template);if(item)renderForm(item);}
    else if(action==='request')openRequest(button.dataset.id);
    else if(action==='save')save();
    else if(action==='withdraw-ask')showConfirmation('withdraw');
    else if(action==='review-ask')showConfirmation('review',button.dataset.decision);
    else if(action==='confirm-cancel'){const slot=dom('.workflow-confirm-slot');if(slot)slot.replaceChildren();}
    else if(action==='confirm')confirm(button.dataset.kind,button.dataset.decision);
  }
  section.addEventListener('click',onClick);
  return {open({templateId=null,list='drafts'}={}){initialTemplate=templateId;view=['drafts','mine','reviews'].includes(list)?list:'drafts';load({openTemplate:templateId});},destroy(){disposed=true;epoch++;section.removeEventListener('click',onClick);section.remove();}};
}
