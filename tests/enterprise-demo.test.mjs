import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const temporary=mkdtempSync(join(tmpdir(),'xiaozi-demo-data-test-')),database=join(temporary,'test.sqlite');let child,base,token,stderr='';
const path=id=>'/api/enterprise/demo/modules/'+id;
async function call(route,{method='GET',authenticated=true}={}){
  const response=await fetch(base+route,{method,headers:authenticated?{Authorization:'Bearer '+token}:{}});return {status:response.status,data:await response.json(),headers:response.headers};
}
function snapshotBusinessTables(){
  const db=new DatabaseSync(database,{readOnly:true});
  try{return Object.fromEntries(['users','conversations','members','messages','media','ai_conversations','ai_messages','enterprise_query_audit','workflow_requests','workflow_reviewers','workflow_audit'].map(table=>[table,db.prepare('SELECT * FROM '+table).all()]));}finally{db.close();}
}
before(async()=>{
  child=spawn(process.execPath,[resolve('server/index.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DB_PATH:database,MEDIA_DIR:join(temporary,'uploads'),ICHAT_DEMO:'0',XIAOZI_LLM_API_KEY:'',XIAOZI_LLM_MODEL:'',XIAOZI_LLM_BASE_URL:'',XIAOZI_ENTERPRISE_CONFIG:''},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Server start timeout '+stderr)),10000);child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>{const match=chunk.toString().match(/listening on (http:\/\/\S+)/);if(match){base=match[1];clearTimeout(timer);accept();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected exit '+code+': '+stderr));});});
  const response=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo_owned_test',displayName:'演示测试账号',password:'DemoTestOnly2026!'})});assert.equal(response.status,201);token=(await response.json()).token;
});
after(async()=>{if(child&&child.exitCode===null)await new Promise(accept=>{const timer=setTimeout(()=>{child.kill();accept();},4000);child.once('exit',()=>{clearTimeout(timer);accept();});child.send('shutdown');});rmSync(temporary,{recursive:true,force:true});});
test('demo APIs require a login and clearly identify all four fixed fictional data sources',async()=>{
  for(const id of ['energy','prices','knowledge','projects']){
    assert.equal((await call(path(id),{authenticated:false})).status,401);
    const result=await call(path(id));assert.equal(result.status,200);assert.equal(result.data.moduleId,id);assert.equal(result.data.isDemo,true);assert.equal(result.data.mode,'demo');assert.equal(result.data.meta.demo,true);assert.equal(result.data.meta.sourceLabel,'模拟演示');assert.equal(result.data.meta.sampleDate,'2026-11-14');assert.match(result.data.meta.disclaimer,/示例.*不作经营决策/);assert.equal(Object.hasOwn(result.data,'updatedAt'),false);
  }
});
test('hourly energy and price examples are bounded, repeatable and internally consistent with labeled units and dates',async()=>{
  const energy=(await call(path('energy'))).data,again=(await call(path('energy'))).data;assert.deepEqual(energy,again);assert.equal(energy.data.series.length,24);assert.equal(energy.data.units.power,'kW');assert.equal(energy.data.units.energy,'kWh');assert.equal(energy.data.metrics[0].value,energy.data.series.reduce((sum,point)=>sum+point.loadKw,0));assert.equal(energy.data.metrics[1].value,energy.data.series.reduce((sum,point)=>sum+point.pvKw,0));
  assert.deepEqual(energy.data.series.map(point=>point.hour),Array.from({length:24},(_,hour)=>String(hour).padStart(2,'0')+':00'));
  const prices=(await call(path('prices'))).data.data;assert.equal(prices.series.length,24);assert.equal(prices.unit,'元/kWh');assert.notEqual(prices.forecastDate,prices.historyDate);assert(prices.series.every(point=>Number.isFinite(point.actual)&&Number.isFinite(point.predicted)&&['峰','平','谷'].includes(point.band)));assert.equal(prices.metrics[1].value,Math.max(...prices.series.map(point=>point.predicted)));assert(prices.strategies.every(item=>/示例/.test(item.title)));
});
test('sample document and project queries filter actual fixtures and return zero for unknown terms',async()=>{
  const documents=(await call(path('knowledge')+'?q='+encodeURIComponent('储能 巡检'))).data.data;assert.equal(documents.query,'储能 巡检');assert.equal(documents.total,1);assert.equal(documents.documents[0].id,'demo-storage-safety');assert.match(documents.documents[0].content,/虚构/);
  const none=(await call(path('knowledge')+'?q='+encodeURIComponent('完全不存在的样例关键词'))).data.data;assert.equal(none.total,0);assert.deepEqual(none.documents,[]);
  const projects=(await call(path('projects')+'?q='+encodeURIComponent('南园区'))).data.data;assert.equal(projects.projects.length,1);assert.equal(projects.projects[0].id,'demo-south-storage');assert(projects.projects[0].milestones.every(item=>typeof item.date==='string'));assert.equal(projects.metrics[0].value,1);
});
test('viewing samples neither grants real enterprise access nor changes business tables or executes commands',async()=>{
  const before=snapshotBusinessTables();
  for(const id of ['energy','prices','knowledge','projects'])await call(path(id));
  const workspace=(await call('/api/enterprise/workspace')).data;assert.equal(workspace.connectedCount,0);assert(workspace.modules.every(module=>module.status==='unconfigured'&&module.capabilities.query===false&&module.capabilities.control===false&&module.capabilities.approval===false));
  assert.equal((await call('/api/enterprise/modules/energy')).status,503);
  const mutation=await call(path('energy'),{method:'POST'});assert.equal(mutation.status,405);assert.equal(mutation.headers.get('allow'),'GET');
  assert.equal((await call(path('energy')+'/control',{method:'POST'})).status,404);
  assert.equal((await call(path('unknown'))).status,404);assert.equal((await call(path('knowledge')+'?q='+'x'.repeat(121))).status,400);
  assert.deepEqual(snapshotBusinessTables(),before);
});
