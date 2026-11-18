import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrateWorkflows,createWorkflows} from '../server/workflows.mjs';

const temporary=mkdtempSync(join(tmpdir(),'xiaozi-workflow-test-')),fixtures=[],password='WorkflowTestOnly2026!';
const valid={
  leave:{leaveType:'年假',startDate:'2026-11-20',endDate:'2026-11-21',reason:'办理个人事务'},
  travel:{destination:'上海',startDate:'2026-11-20',endDate:'2026-11-21',purpose:'项目现场验收'},
  expense:{expenseType:'差旅',amount:'120.50',date:'2026-11-20',description:'项目交通费用'},
  purchase:{item:'巡检工具',quantity:'2',amount:'980.00',reason:'项目现场巡检'}
};
function fixture(name){
  const app={database:join(temporary,name+'.sqlite'),configPath:join(temporary,name+'.json'),base:'',child:null,stderr:'',
    async start(config){this.stderr='';if(config)writeFileSync(this.configPath,JSON.stringify(config));this.child=spawn(process.execPath,[resolve('server/index.mjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DB_PATH:this.database,MEDIA_DIR:join(temporary,name+'-uploads'),ICHAT_DEMO:'0',XIAOZI_LLM_API_KEY:'',XIAOZI_LLM_MODEL:'',XIAOZI_LLM_BASE_URL:'',XIAOZI_ENTERPRISE_CONFIG:config?this.configPath:''},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout '+this.stderr)),10000);this.child.stdout.on('data',chunk=>{const match=chunk.toString().match(/listening on (http:\/\/\S+)/);if(match){this.base=match[1];clearTimeout(timer);accept();}});this.child.stderr.on('data',chunk=>this.stderr+=chunk);this.child.once('error',reject);this.child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected exit '+code+': '+this.stderr));});});},
    async stop(){if(!this.child||this.child.exitCode!==null)return;const child=this.child;await new Promise(accept=>{const timer=setTimeout(()=>{child.kill();accept();},4000);child.once('exit',()=>{clearTimeout(timer);accept();});child.send('shutdown');});},
    async call(route,{method='GET',token,body}={}){const response=await fetch(this.base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};},
    async account(prefix){const username=prefix+'_'+randomUUID().slice(0,8),result=await this.call('/api/register',{method:'POST',body:{username,displayName:prefix,password}});assert.equal(result.status,201);return result.data;},
    async draft(user,type='leave',data={}){const result=await this.call('/api/workflows',{method:'POST',token:user.token,body:{templateId:type,data}});assert.equal(result.status,201,JSON.stringify(result.data));return result.data.request;},
    async action(user,request,action,extra={}){return this.call('/api/workflows/'+request.id+'/'+action,{method:'POST',token:user.token,body:{version:request.version,...extra}});}
  };fixtures.push(app);return app;
}
const noConfig=fixture('none'),enterprise=fixture('enterprise');
let applicant,reviewer,reviewer2,unassignedAdmin,publicUser,config;
before(async()=>{
  await noConfig.start();await enterprise.start();
  applicant=await enterprise.account('applicant');reviewer=await enterprise.account('reviewer');reviewer2=await enterprise.account('reviewer2');unassignedAdmin=await enterprise.account('admin');publicUser=await enterprise.account('public');
  config={organizationId:'owned-test-company',organization:'测试能源公司',members:Object.fromEntries([applicant,reviewer,reviewer2,unassignedAdmin].map(account=>[account.user.id,{role:account===unassignedAdmin?'admin':'employee',modules:[]}])),modules:{},workflows:{reviewers:Object.fromEntries(Object.keys(valid).map(type=>[type,[applicant.user.id,reviewer.user.id,reviewer2.user.id]]))}};
  await enterprise.stop();await enterprise.start(config);
});
after(async()=>{for(const app of fixtures)await app.stop();rmSync(temporary,{recursive:true,force:true});});

test('workflow migration adds only its own tables and leaves pre-existing schema and rows untouched',()=>{
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE legacy_records(id INTEGER PRIMARY KEY,body TEXT);INSERT INTO users VALUES('owned-user');INSERT INTO legacy_records VALUES(1,'original');");
  const snapshot=()=>({schema:db.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('users','legacy_records') ORDER BY name").all(),rows:db.prepare('SELECT * FROM legacy_records').all()});
  const before=snapshot(),transaction=fn=>{db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
  migrateWorkflows(db,transaction);migrateWorkflows(db,transaction);assert.deepEqual(snapshot(),before);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").all().map(row=>row.name),['workflow_audit','workflow_requests','workflow_reviewers']);db.close();
});
test('invalid configured reviewers fail closed without printing configuration content',()=>{
  const path=join(temporary,'invalid-reviewers.json'),sensitive='config-content-must-not-appear';
  writeFileSync(path,JSON.stringify({organization:'test',members:{},workflows:{reviewers:{leave:[sensitive]}}}));
  assert.throws(()=>createWorkflows({env:{XIAOZI_ENTERPRISE_CONFIG:path},getUser:()=>null}),error=>error.message.includes('内部流程配置无效')&&!error.message.includes(sensitive));
});
test('unconfigured workflows require login, persist private drafts and never claim submission',async()=>{
  assert.equal((await noConfig.call('/api/workflows')).status,401);
  const user=await noConfig.account('owner'),other=await noConfig.account('other'),initial=(await noConfig.call('/api/workflows',{token:user.token})).data;
  assert.equal(initial.templates.length,4);assert.equal(initial.configured,false);assert.deepEqual(initial.requests,[]);assert.deepEqual(initial.reviews,[]);assert(initial.templates.every(template=>template.submissionEnabled===false));
  const draft=await noConfig.draft(user,'leave');assert.equal(draft.status,'draft');assert.equal(draft.version,1);assert.equal(draft.canEdit,true);assert.equal(draft.canSubmit,false);
  const blocked=await noConfig.action(user,draft,'submit');assert.equal(blocked.status,503);assert.match(blocked.data.error,/配置/);
  const detail=(await noConfig.call('/api/workflows/'+draft.id,{token:user.token})).data;assert.equal(detail.request.status,'draft');assert.equal(detail.request.version,1);assert.deepEqual(detail.audit.map(event=>event.action),['created']);
  assert.equal((await noConfig.call('/api/workflows/'+draft.id,{token:other.token})).status,404);
  assert.deepEqual((await noConfig.call('/api/workflows',{token:other.token})).data.requests,[]);
});
test('draft edits use optimistic versions and reject extra fields, invalid dates and invalid amounts',async()=>{
  const user=await noConfig.account('editing'),draft=await noConfig.draft(user);
  const saved=await noConfig.action(user,draft,'save',{data:valid.leave});assert.equal(saved.status,200);assert.equal(saved.data.request.version,2);
  assert.equal((await noConfig.action(user,draft,'save',{data:{reason:'stale overwrite'}})).status,409);
  const cases=[['leave',{unknown:'x'}],['leave',{startDate:'2026-02-30'}],['leave',{startDate:'2026-11-21',endDate:'2026-11-20'}],['expense',{amount:'0'}],['expense',{amount:'12.345'}],['expense',{amount:'1e3'}],['expense',{amount:-1}],['purchase',{quantity:'1.5'}],['purchase',{quantity:'100000'}]];
  for(const [templateId,data]of cases)assert.equal((await noConfig.call('/api/workflows',{method:'POST',token:user.token,body:{templateId,data}})).status,400,JSON.stringify(data));
});
test('configured members can submit each template and only explicitly assigned reviewers receive it',async()=>{
  for(const type of Object.keys(valid)){
    const draft=await enterprise.draft(applicant,type,valid[type]),result=await enterprise.action(applicant,draft,'submit');assert.equal(result.status,200);assert.equal(result.data.request.status,'pending');assert.equal(result.data.request.version,2);assert.equal(result.data.request.canEdit,false);assert.equal(result.data.request.canWithdraw,true);assert.equal(result.data.request.canReview,false);assert.deepEqual(result.data.request.reviewers.map(user=>user.id).sort(),[reviewer.user.id,reviewer2.user.id].sort());
    const inbox=(await enterprise.call('/api/workflows',{token:reviewer.token})).data.reviews;assert(inbox.some(request=>request.id===draft.id&&request.canReview===true));
    assert.equal((await enterprise.call('/api/workflows/'+draft.id,{token:unassignedAdmin.token})).status,404);
    assert.equal((await enterprise.call('/api/workflows/'+draft.id,{token:publicUser.token})).status,404);
    assert.equal((await enterprise.action(applicant,result.data.request,'save',{data:valid[type]})).status,409);
    assert.equal((await enterprise.action(applicant,result.data.request,'review',{decision:'approve'})).status,403);
  }
});
test('public registration does not acquire workflow submission or approval privileges',async()=>{
  const draft=await enterprise.draft(publicUser,'expense',valid.expense);assert.equal(draft.canSubmit,false);assert.equal((await enterprise.action(publicUser,draft,'submit')).status,503);
  assert.deepEqual((await enterprise.call('/api/workflows',{token:publicUser.token})).data.reviews,[]);
});
test('a configured reviewer cannot self-approve an application without another eligible reviewer',async()=>{
  const self=fixture('self-only');await self.start();const owner=await self.account('self');await self.stop();
  await self.start({organizationId:'self-test-company',organization:'self-test',members:{[owner.user.id]:{role:'admin',modules:[]}},modules:{},workflows:{reviewers:{leave:[owner.user.id]}}});
  const draft=await self.draft(owner,'leave',valid.leave);assert.equal(draft.canSubmit,false);
  const result=await self.action(owner,draft,'submit');assert.equal(result.status,503);assert.match(result.data.error,/本人以外/);
  const detail=(await self.call('/api/workflows/'+draft.id,{token:owner.token})).data;assert.equal(detail.request.status,'draft');assert.equal(detail.audit.length,1);
});
test('competing approvals have one atomic winner and a single immutable audit decision',async()=>{
  const draft=await enterprise.draft(applicant,'expense',valid.expense),pending=(await enterprise.action(applicant,draft,'submit')).data.request;
  const decisions=await Promise.all([enterprise.action(reviewer,pending,'review',{decision:'approve',comment:'费用核对完成'}),enterprise.action(reviewer2,pending,'review',{decision:'reject',comment:'另一审批意见'})]);
  assert.deepEqual(decisions.map(result=>result.status).sort(),[200,409]);
  const detail=(await enterprise.call('/api/workflows/'+draft.id,{token:applicant.token})).data;assert(['approved','rejected'].includes(detail.request.status));assert.equal(detail.request.version,3);assert.deepEqual(detail.audit.map(event=>event.version),[1,2,3]);assert.equal(detail.audit.filter(event=>['approved','rejected'].includes(event.action)).length,1);
  assert.equal((await enterprise.action(applicant,detail.request,'withdraw')).status,409);assert.equal((await enterprise.action(applicant,detail.request,'save',{data:valid.expense})).status,409);
});
test('withdrawal restores a draft, removes reviewer access and permits explicit resubmission',async()=>{
  const draft=await enterprise.draft(applicant,'travel',valid.travel),pending=(await enterprise.action(applicant,draft,'submit')).data.request;
  const withdrawn=await enterprise.action(applicant,pending,'withdraw');assert.equal(withdrawn.status,200);assert.equal(withdrawn.data.request.status,'draft');assert.deepEqual(withdrawn.data.request.reviewers,[]);assert.equal(withdrawn.data.request.version,3);
  assert.equal((await enterprise.call('/api/workflows/'+draft.id,{token:reviewer.token})).status,404);
  const submitted=await enterprise.action(applicant,withdrawn.data.request,'submit');assert.equal(submitted.status,200);assert.equal(submitted.data.request.status,'pending');assert.equal(submitted.data.request.version,4);
});
test('submit validation requires all business fields while drafts remain editable',async()=>{
  const incomplete=await enterprise.draft(applicant,'purchase',{item:'巡检仪'}),result=await enterprise.action(applicant,incomplete,'submit');assert.equal(result.status,400);
  const detail=(await enterprise.call('/api/workflows/'+incomplete.id,{token:applicant.token})).data;assert.equal(detail.request.status,'draft');assert.equal(detail.request.version,1);assert.equal(detail.audit.length,1);
});
test('a revoked reviewer token cannot finish a held approval request',async()=>{
  const draft=await enterprise.draft(applicant,'leave',valid.leave),pending=(await enterprise.action(applicant,draft,'submit')).data.request;
  const bytes=Buffer.from(JSON.stringify({version:pending.version,decision:'approve'}));let request,readyAccept,readyReject;
  const ready=new Promise((accept,reject)=>{readyAccept=accept;readyReject=reject;}),response=new Promise((accept,reject)=>{request=http.request(enterprise.base+'/api/workflows/'+pending.id+'/review',{method:'POST',headers:{Authorization:'Bearer '+reviewer2.token,'Content-Type':'application/json','Content-Length':bytes.length,Expect:'100-continue'}},res=>{res.resume();res.once('end',()=>accept(res.statusCode));});request.on('error',error=>{readyReject(error);reject(error);});});
  const timer=setTimeout(()=>readyReject(Error('Held approval not received')),2000);request.once('continue',()=>{clearTimeout(timer);request.write(bytes.subarray(0,1));readyAccept();});request.flushHeaders();await ready;
  assert.equal((await enterprise.call('/api/logout',{method:'POST',token:reviewer2.token,body:{}})).status,200);request.end(bytes.subarray(1));assert.equal(await response,401);
  const detail=(await enterprise.call('/api/workflows/'+pending.id,{token:applicant.token})).data;assert.equal(detail.request.status,'pending');assert.equal(detail.audit.length,2);
});
test('restart retains drafts and pending requests, while a different enterprise cannot read submitted business records',async()=>{
  const draft=await enterprise.draft(applicant,'purchase',valid.purchase),pending=(await enterprise.action(applicant,draft,'submit')).data.request,privateDraft=await enterprise.draft(applicant,'leave',{reason:'私有草稿'});
  await enterprise.stop();await enterprise.start({...config,organizationId:'another-test-company',organization:'另一企业'});
  assert.equal((await enterprise.call('/api/workflows/'+pending.id,{token:applicant.token})).status,404);assert.equal((await enterprise.call('/api/workflows/'+pending.id,{token:reviewer.token})).status,404);
  assert.equal((await enterprise.call('/api/workflows/'+privateDraft.id,{token:applicant.token})).data.request.status,'draft');
  await enterprise.stop();await enterprise.start(config);const detail=(await enterprise.call('/api/workflows/'+pending.id,{token:applicant.token})).data;assert.equal(detail.request.status,'pending');assert.deepEqual(detail.audit.map(event=>event.action),['created','submitted']);
});
