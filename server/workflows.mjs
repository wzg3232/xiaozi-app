import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';

const text=(name,label,maxLength=100)=>({name,label,type:'text',required:true,maxLength});
const date=(name,label)=>({name,label,type:'date',required:true});
const reason=(name='reason',label='申请事由')=>({name,label,type:'textarea',required:true,maxLength:1000});
const select=(name,label,options)=>({name,label,type:'select',required:true,options:options.map(value=>({value,label:value}))});
const amount=()=>({name:'amount',label:'金额（人民币/元）',unit:'元',type:'number',required:true,min:0.01,max:9999999.99,step:0.01});
const templates=[
  {id:'leave',title:'请假申请',description:'填写请假日期与事由',fields:[select('leaveType','请假类型',['事假','病假','年假','调休']),date('startDate','开始日期'),date('endDate','结束日期'),reason()]},
  {id:'travel',title:'出差申请',description:'填写目的地、行程日期与工作安排',fields:[text('destination','出差目的地'),date('startDate','开始日期'),date('endDate','结束日期'),reason('purpose','出差事由')]},
  {id:'expense',title:'报销申请',description:'记录费用类型、金额与用途',fields:[select('expenseType','费用类型',['差旅','交通','办公','其他']),amount(),date('date','费用发生日期'),reason('description','费用说明')]},
  {id:'purchase',title:'采购申请',description:'填写采购项目、数量与预算',fields:[text('item','采购项目'),{name:'quantity',label:'采购数量',type:'number',required:true,min:1,max:99999,step:1},amount(),reason()]}
];
function policyFromEnvironment(env,getUser){
  const empty={organization:null,organizationId:null,members:{},reviewers:{}};
  if(!env.XIAOZI_ENTERPRISE_CONFIG)return empty;
  try{
    if(statSync(env.XIAOZI_ENTERPRISE_CONFIG).size>1024*1024)throw Error();
    const input=JSON.parse(readFileSync(env.XIAOZI_ENTERPRISE_CONFIG,'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
    const organization=typeof input.organization==='string'?input.organization.trim().slice(0,80):'';
    const organizationId=typeof input.organizationId==='string'?input.organizationId.trim():'';
    if(organizationId.length>120)throw Error();
    const policy={...empty,organization:organization||null,organizationId:organizationId||(organization?'name:'+createHash('sha256').update(organization).digest('hex'):null),members:input.members||{},reviewers:{}};
    if(typeof policy.members!=='object'||Array.isArray(policy.members))throw Error();
    for(const member of Object.values(policy.members))if(!member||!['employee','admin'].includes(member.role))throw Error();
    if(input.workflows===undefined)return policy;
    if(!input.workflows||typeof input.workflows!=='object'||Array.isArray(input.workflows)||!input.workflows.reviewers||typeof input.workflows.reviewers!=='object'||Array.isArray(input.workflows.reviewers)||!policy.organizationId)throw Error();
    for(const [type,ids]of Object.entries(input.workflows.reviewers)){
      if(!templates.some(template=>template.id===type)||!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string'||!id||id.length>80||!policy.members[id]||!getUser(id)))throw Error();
      policy.reviewers[type]=[...new Set(ids)];
    }
    return policy;
  }catch{throw Error('内部流程配置无效，请检查企业成员与审批人配置（未输出配置内容）');}
}
export function migrateWorkflows(db,transaction){
  transaction(()=>db.exec([
    "CREATE TABLE IF NOT EXISTS workflow_requests(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),template_id TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,data_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,submitted_at TEXT,reviewed_at TEXT,reviewed_by TEXT REFERENCES users(id),decision_comment TEXT NOT NULL DEFAULT '');",
    "CREATE INDEX IF NOT EXISTS workflow_request_owner ON workflow_requests(owner_id,updated_at);",
    "CREATE INDEX IF NOT EXISTS workflow_request_organization ON workflow_requests(organization_id,status,updated_at);",
    "CREATE TABLE IF NOT EXISTS workflow_reviewers(request_id TEXT NOT NULL REFERENCES workflow_requests(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(request_id,user_id));",
    "CREATE INDEX IF NOT EXISTS workflow_reviewer_user ON workflow_reviewers(user_id,request_id);",
    "CREATE TABLE IF NOT EXISTS workflow_audit(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES workflow_requests(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,version INTEGER NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,UNIQUE(request_id,version));",
    "CREATE INDEX IF NOT EXISTS workflow_audit_request ON workflow_audit(request_id,version);"
  ].join('\n')));
}
export function createWorkflows({db,transaction,body,json,requireSession,rateLimit,fail,nowISO,getUser,env=process.env}){
  const policy=policyFromEnvironment(env,getUser);
  const templateFor=id=>templates.find(template=>template.id===id);
  const member=id=>!!policy.members[id]&&!!policy.organizationId;
  function reviewerIds(type,owner){return (policy.reviewers[type]||[]).filter(id=>id!==owner&&member(id)&&!!getUser(id));}
  function submitReason(type,userId){
    if(!policy.organizationId||!member(userId))return '请先由企业管理员配置企业成员与审批人';
    if(!reviewerIds(type,userId).length)return '该流程尚未配置本人以外的有效审批人';
    return '';
  }
  function currentTenant(row){return !!row.organization_id&&row.organization_id===policy.organizationId;}
  function canReview(row,userId){
    return row.status==='pending'&&row.owner_id!==userId&&currentTenant(row)&&member(userId)&&(policy.reviewers[row.template_id]||[]).includes(userId)&&!!db.prepare('SELECT 1 FROM workflow_reviewers WHERE request_id=? AND user_id=?').get(row.id,userId);
  }
  function visible(row,userId){
    if(!row)return false;
    if(row.owner_id===userId)return row.status==='draft'&&row.organization_id===null||currentTenant(row)&&member(userId);
    return currentTenant(row)&&member(userId)&&(policy.reviewers[row.template_id]||[]).includes(userId)&&!!db.prepare('SELECT 1 FROM workflow_reviewers WHERE request_id=? AND user_id=?').get(row.id,userId);
  }
  function getVisible(id,userId){const row=db.prepare('SELECT * FROM workflow_requests WHERE id=?').get(id);if(!visible(row,userId))throw fail(404,'申请不存在或你没有查看权限');return row;}
  function actor(id){const user=getUser(id);return {id,displayName:user?.display_name||'原企业成员'};}
  function view(row,userId){
    const own=row.owner_id===userId;
    return {id:row.id,templateId:row.template_id,title:templateFor(row.template_id)?.title||'内部申请',status:row.status,version:row.version,data:JSON.parse(row.data_json),createdAt:row.created_at,updatedAt:row.updated_at,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,reviewedBy:row.reviewed_by?actor(row.reviewed_by):null,decisionComment:row.decision_comment,applicant:actor(row.owner_id),reviewers:db.prepare('SELECT user_id FROM workflow_reviewers WHERE request_id=? ORDER BY user_id').all(row.id).map(item=>actor(item.user_id)),canEdit:own&&row.status==='draft',canSubmit:own&&row.status==='draft'&&!submitReason(row.template_id,userId),canWithdraw:own&&row.status==='pending'&&member(userId)&&currentTenant(row),canReview:canReview(row,userId),submissionReason:own?submitReason(row.template_id,userId):''};
  }
  function validateData(type,input,complete){
    const template=templateFor(type);if(!template)throw fail(400,'请选择有效的申请模板');
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'申请内容格式不正确');
    if(Object.keys(input).some(name=>!template.fields.some(field=>field.name===name)))throw fail(400,'申请包含此模板不支持的字段');
    const result={};
    for(const field of template.fields){
      let value=input[field.name];
      if(value===undefined||value===null)value='';
      if(typeof value==='number'&&Number.isFinite(value)&&field.type==='number')value=String(value);
      if(typeof value!=='string')throw fail(400,field.label+'格式不正确');value=value.trim();
      if(!value){if(complete&&field.required)throw fail(400,'请填写'+field.label);if(Object.hasOwn(input,field.name))result[field.name]='';continue;}
      if(value.length>(field.maxLength||120))throw fail(400,field.label+'内容过长');
      if(field.type==='select'&&!field.options.some(option=>option.value===value))throw fail(400,'请选择有效的'+field.label);
      if(field.type==='date'){
        const parsed=new Date(value+'T00:00:00.000Z');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw fail(400,field.label+'不是有效日期');
      }
      if(field.type==='number'){
        if(field.name==='quantity'){if(!/^\d{1,5}$/.test(value)||Number(value)<1||Number(value)>99999)throw fail(400,'采购数量需为 1–99999 的整数');}
        else if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)||Number(value)<0.01||Number(value)>9999999.99)throw fail(400,'金额需为 0.01–9999999.99 元，最多两位小数');
      }
      result[field.name]=value;
    }
    if(result.startDate&&result.endDate&&result.startDate>result.endDate)throw fail(400,'结束日期不能早于开始日期');
    return result;
  }
  function audit(id,userId,action,version,detail={}){
    db.prepare('INSERT INTO workflow_audit(id,request_id,actor_id,action,version,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,userId,action,version,JSON.stringify(detail),nowISO());
  }
  function expectedVersion(input,row){if(!Number.isSafeInteger(input.version)||input.version!==row.version)throw fail(409,'申请状态已更新，请刷新后再操作');}
  function requireOwner(row,userId){if(row.owner_id!==userId)throw fail(403,'只有申请人本人可以修改这份申请');}
  function updateResult(res,id,userId){json(res,200,{request:view(getVisible(id,userId),userId)});}
  return {async handle(req,res,url,user,token){
    const route=url.pathname;
    if(route==='/api/workflows'){
      if(req.method==='GET'){
        const requests=db.prepare('SELECT * FROM workflow_requests WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200').all(user.id).filter(row=>visible(row,user.id)).map(row=>view(row,user.id));
        const reviews=member(user.id)?db.prepare("SELECT r.* FROM workflow_requests r JOIN workflow_reviewers v ON r.id=v.request_id WHERE v.user_id=? AND r.status='pending' AND r.organization_id=? ORDER BY r.updated_at DESC LIMIT 200").all(user.id,policy.organizationId).filter(row=>canReview(row,user.id)).map(row=>view(row,user.id)):[];
        const configured=!!policy.organizationId&&Object.values(policy.reviewers).some(ids=>ids.length);
        json(res,200,{templates:templates.map(template=>({...template,submissionEnabled:!submitReason(template.id,user.id),submissionReason:submitReason(template.id,user.id)})),requests,reviews,configured,reason:configured?(member(user.id)?'流程按企业授权处理':'当前账号尚未获得企业成员授权'):'企业审批人尚未配置，可先保存申请草稿',organization:member(user.id)?policy.organization:null});return true;
      }
      if(req.method==='POST'){
        rateLimit(req,'workflow-create',30,60000,user.id);const input=await body(req);user=requireSession(token);if(!templateFor(input.templateId))throw fail(400,'请选择有效的申请模板');
        if(db.prepare('SELECT count(*) AS n FROM workflow_requests WHERE owner_id=?').get(user.id).n>=500)throw fail(409,'个人申请数量已达上限，请联系管理员归档');
        const data=validateData(input.templateId,input.data??{},false),id=randomUUID(),now=nowISO();
        transaction(()=>{db.prepare("INSERT INTO workflow_requests(id,owner_id,template_id,status,version,data_json,created_at,updated_at) VALUES(?,?,?,'draft',1,?,?,?)").run(id,user.id,input.templateId,JSON.stringify(data),now,now);audit(id,user.id,'created',1);});
        json(res,201,{request:view(getVisible(id,user.id),user.id)});return true;
      }
    }
    const match=route.match(/^\/api\/workflows\/([a-zA-Z0-9-]{1,80})(?:\/(save|submit|withdraw|review))?$/);
    if(!match)return false;
    let row=getVisible(match[1],user.id);const action=match[2];
    if(!action&&req.method==='GET'){
      const events=db.prepare('SELECT * FROM workflow_audit WHERE request_id=? ORDER BY version').all(row.id).map(event=>({id:event.id,actor:actor(event.actor_id),action:event.action,version:event.version,detail:JSON.parse(event.detail_json),createdAt:event.created_at}));
      json(res,200,{request:view(row,user.id),audit:events});return true;
    }
    if(req.method!=='POST'||!action)return false;
    rateLimit(req,'workflow-action',60,60000,user.id);const input=await body(req);user=requireSession(token);row=getVisible(row.id,user.id);expectedVersion(input,row);
    const now=nowISO(),nextVersion=row.version+1;
    if(action==='save'){
      requireOwner(row,user.id);if(row.status!=='draft')throw fail(409,'只有草稿可以编辑');
      const data=validateData(row.template_id,input.data??{},false);
      transaction(()=>{const result=db.prepare("UPDATE workflow_requests SET data_json=?,updated_at=?,version=? WHERE id=? AND owner_id=? AND status='draft' AND version=?").run(JSON.stringify(data),now,nextVersion,row.id,user.id,row.version);if(result.changes!==1)throw fail(409,'申请状态已更新，请刷新后再操作');audit(row.id,user.id,'saved',nextVersion,{changedFields:Object.keys(data)});});
      updateResult(res,row.id,user.id);return true;
    }
    if(action==='submit'){
      requireOwner(row,user.id);if(row.status!=='draft')throw fail(409,'只有草稿可以提交');
      const unavailable=submitReason(row.template_id,user.id);if(unavailable)throw fail(503,unavailable+'；草稿保持原样');
      validateData(row.template_id,JSON.parse(row.data_json),true);const reviewers=reviewerIds(row.template_id,user.id);
      transaction(()=>{const result=db.prepare("UPDATE workflow_requests SET organization_id=?,status='pending',version=?,updated_at=?,submitted_at=?,reviewed_at=NULL,reviewed_by=NULL,decision_comment='' WHERE id=? AND owner_id=? AND status='draft' AND version=?").run(policy.organizationId,nextVersion,now,now,row.id,user.id,row.version);if(result.changes!==1)throw fail(409,'申请状态已更新，请刷新后再操作');db.prepare('DELETE FROM workflow_reviewers WHERE request_id=?').run(row.id);for(const id of reviewers)db.prepare('INSERT INTO workflow_reviewers(request_id,user_id) VALUES(?,?)').run(row.id,id);audit(row.id,user.id,'submitted',nextVersion,{reviewerIds:reviewers});});
      updateResult(res,row.id,user.id);return true;
    }
    if(action==='withdraw'){
      requireOwner(row,user.id);if(row.status!=='pending'||!currentTenant(row)||!member(user.id))throw fail(409,'只有尚未处理的本人申请可以撤回');
      transaction(()=>{const result=db.prepare("UPDATE workflow_requests SET status='draft',organization_id=NULL,version=?,updated_at=?,submitted_at=NULL WHERE id=? AND owner_id=? AND status='pending' AND version=?").run(nextVersion,now,row.id,user.id,row.version);if(result.changes!==1)throw fail(409,'申请状态已更新，请刷新后再操作');db.prepare('DELETE FROM workflow_reviewers WHERE request_id=?').run(row.id);audit(row.id,user.id,'withdrawn',nextVersion);});
      updateResult(res,row.id,user.id);return true;
    }
    if(action==='review'){
      if(!canReview(row,user.id))throw fail(row.status==='pending'?403:409,'你不是这份待办的当前审批人，或申请已被处理');
      if(!['approve','reject'].includes(input.decision))throw fail(400,'请选择同意或拒绝');
      const comment=input.comment===undefined?'':typeof input.comment==='string'?input.comment.trim():null;if(comment===null||comment.length>1000)throw fail(400,'审批意见需为 1000 字以内的文本');
      const status=input.decision==='approve'?'approved':'rejected';
      transaction(()=>{const result=db.prepare("UPDATE workflow_requests SET status=?,version=?,updated_at=?,reviewed_at=?,reviewed_by=?,decision_comment=? WHERE id=? AND status='pending' AND version=? AND organization_id=?").run(status,nextVersion,now,now,user.id,comment,row.id,row.version,policy.organizationId);if(result.changes!==1)throw fail(409,'申请状态已更新，请刷新后再操作');audit(row.id,user.id,status,nextVersion,{comment});});
      updateResult(res,row.id,user.id);return true;
    }
    return false;
  }};
}
