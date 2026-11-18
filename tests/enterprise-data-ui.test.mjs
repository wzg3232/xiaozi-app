import test from 'node:test';
import assert from 'node:assert/strict';
import {chartGeometry,presentBusinessData,readableBusinessValue,renderBusinessData,renderKnowledgeDocument} from '../web/assets/enterprise-data.js';
import {normalizeEnterpriseModules} from '../web/assets/enterprise.js';
import {createDemoEnterprise} from '../server/demo-enterprise.mjs';

test('energy chart supports charging below zero without plotting absent samples as zero',()=>{
  const geometry=chartGeometry([{hour:'00:00',storageKw:-120},{hour:'01:00',storageKw:null},{hour:'02:00',storageKw:80},{hour:'03:00',storageKw:false}],['storageKw']);
  assert.equal(geometry.min,-120);assert.equal(geometry.max,80);
  assert.deepEqual(geometry.lines[0].points.map(point=>point.value),[-120,80]);
  assert.equal(geometry.lines[0].points[0].y,150);assert.equal(geometry.lines[0].points[1].y,0);
});

test('no finite observations yields an empty chart, and long series is bounded',()=>{
  assert.equal(chartGeometry([{hour:'00:00',loadKw:NaN},{hour:'01:00',loadKw:Infinity}],['loadKw']),null);
  const geometry=chartGeometry(Array.from({length:10000},(_,index)=>({hour:index,loadKw:index})),['loadKw']);
  assert.equal(geometry.lines[0].points.length,96);assert.equal(geometry.labels.length,96);
  const one=chartGeometry([{hour:'12:00',loadKw:0}],['loadKw']);
  assert.equal(one.lines[0].points[0].x,300);assert(Number.isFinite(one.lines[0].points[0].y));
});

test('24 hour price view renders both curves and the corresponding accessible hourly values',()=>{
  const series=Array.from({length:24},(_,index)=>({hour:String(index).padStart(2,'0')+':00',predicted:.31+index/100,actual:.3+index/100,band:index<6?'谷':'平'}));
  const html=renderBusinessData({isDemo:true,data:{series,forecastDate:'2026-11-14',historyDate:'2026-11-13',strategies:[{title:'谷段示例',period:'00:00–06:00',description:'不发送设备指令'}]}},{moduleId:'prices',mode:'demo'});
  assert.equal((html.match(/<polyline /g)||[]).length,2);assert.equal((html.match(/<tbody><tr>|<\/tr><tr>/g)||[]).length,24);
  assert.match(html,/预测日期：2026-11-14/);assert.match(html,/对照日期：2026-11-13/);
  assert.match(html,/23:00/);assert.match(html,/0\.54/);assert.match(html,/查看逐小时数据/);assert.match(html,/00:00–06:00/);
});

test('empty knowledge search remains empty and never adds fictional matches',()=>{
  const html=renderBusinessData({data:{query:'不存在',total:0,documents:[]}},{moduleId:'knowledge',mode:'demo'});
  assert.match(html,/0 份/);assert.match(html,/没有找到匹配资料/);assert.doesNotMatch(html,/data-document=/);
});

test('knowledge cards and full text escape markup and preserve document text',()=>{
  const document={id:'x" onclick="alert(1)',title:'<script>bad()</script>',category:'<svg>',content:'第一行\n<img src=x onerror=alert(1)>',tags:['<b>']};
  const html=renderBusinessData({data:{documents:[document]}},{moduleId:'knowledge',mode:'demo'});
  assert.match(html,/查看文档正文/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<svg>|<b>/);
  assert.match(html,/data-document="x&quot; onclick=&quot;alert\(1\)"/);
  const reader=renderKnowledgeDocument(document,{mode:'demo'});
  assert.match(reader,/&lt;svg&gt;/);assert.match(reader,/第一行\n&lt;img/);assert.doesNotMatch(reader,/<img/);
});

test('project progress is bounded to real progressbar limits and untrusted milestones are escaped',()=>{
  const html=renderBusinessData({data:{projects:[{name:'<img>',progress:140,status:'进行中',milestones:[{name:'<script>',status:'自定义" onclick="x',date:'2026-11-14'}]},{name:'negative',progress:-20}]}},{moduleId:'projects',mode:'demo'});
  assert.match(html,/aria-valuenow="100"/);assert.match(html,/aria-valuenow="0"/);assert.doesNotMatch(html,/width:140|width:-20|<img>|<script>/);
  assert.match(html,/class="todo"/);assert.match(html,/自定义&quot; onclick=&quot;x/);assert.match(html,/2 项/);
});

test('unmapped enterprise data is readable labelled content instead of a raw JSON block',()=>{
  const html=readableBusinessValue({name:'储能一号',status:'待机',description:'<script>',records:[{value:12,unit:'kWh'}]});
  assert.match(html,/<dt>名称<\/dt><dd>储能一号<\/dd>/);assert.match(html,/<dt>状态<\/dt><dd>待机<\/dd>/);assert.match(html,/<dt>数值<\/dt><dd>12<\/dd>/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<pre>|<script>/);
  assert.match(readableBusinessValue([]),/暂无匹配记录/);
});

test('custom enterprise IDs retain a fixed separate demo module key and do not gain permissions',()=>{
  const [module]=normalizeEnterpriseModules({modules:[{id:'private-energy-source',title:'能源管理',status:'forbidden',capabilities:{query:true}}]});
  assert.equal(module.id,'private-energy-source');assert.equal(module.demoId,'energy');assert.equal(module.capabilities.query,false);
});

function fixedModule(id,query=''){
  let payload;
  const service=createDemoEnterprise({json:(_response,_status,data)=>payload=data,fail:(status,message)=>Object.assign(Error(message),{status})});
  assert.equal(service.handle({method:'GET'},{setHeader(){}},new URL('https://localhost/api/enterprise/demo/modules/'+id+'?q='+encodeURIComponent(query))),true);
  return payload;
}

test('all fixed business views use production interface copy while keeping dates, figures and queries intact',()=>{
  for(const id of ['energy','prices','knowledge','projects']){
    const result=fixedModule(id),original=structuredClone(result),html=renderBusinessData(result,{moduleId:id,mode:'demo'});
    assert.doesNotMatch(html,/模拟|演示|示例|样例|虚构|已连接|实时采集|实时同步/);
    assert.deepEqual(result,original,'presentation must not mutate source data');
    const presented=presentBusinessData(result,{mode:'demo'});
    if(result.data.metrics)assert.deepEqual(presented.metrics.map(item=>[item.value,item.unit]),result.data.metrics.map(item=>[item.value,item.unit]));
    if(id==='knowledge')for(const document of result.data.documents){
      const reader=renderKnowledgeDocument(document,{mode:'demo'});
      assert.doesNotMatch(reader,/模拟|演示|示例|样例|虚构|不是实际数据|仅用于/);assert.match(reader,/2026-11-/);
      assert.match(reader,/巡检|电价|验收|申请/);
    }
  }
  const filtered=fixedModule('knowledge','储能'),view=presentBusinessData(filtered,{mode:'demo'});
  assert.equal(view.documents.length,filtered.data.documents.length);assert.equal(view.query,'储能');
  assert.equal(fixedModule('knowledge','没有这个文档').data.documents.length,0);
});

test('actual enterprise data and user text are never rewritten as fixed interface copy',()=>{
  const data={metrics:[{label:'模拟分析结果',value:1200.5,unit:'元',hint:'用户提供'}],documents:[{id:'demo-storage-safety',title:'用户示例材料',content:'用户的模拟与演示说明'}]};
  assert.equal(presentBusinessData({data},{mode:'enterprise'}),data);
  assert.equal(presentBusinessData({isDemo:true,data},{mode:'enterprise'}),data);
  assert.match(renderKnowledgeDocument(data.documents[0],{mode:'enterprise'}),/用户的模拟与演示说明/);
  assert.match(renderBusinessData({data},{moduleId:'knowledge',mode:'enterprise'}),/用户示例材料/);
});
