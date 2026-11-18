import test from 'node:test';
import assert from 'node:assert/strict';
import {collectWorkflowData,workflowList} from '../web/assets/workflows.js';

const form=values=>({elements:{namedItem:name=>Object.hasOwn(values,name)?{value:values[name]}:null}});
const leave={fields:[{name:'leaveType',label:'请假类型',type:'select',required:true,options:[{value:'事假',label:'事假'},{value:'年假',label:'年假'}]},{name:'startDate',label:'开始日期',type:'date',required:true},{name:'endDate',label:'结束日期',type:'date',required:true},{name:'reason',label:'申请事由',type:'textarea',required:true,maxLength:1000}]};
const purchase={fields:[{name:'item',label:'采购项目',type:'text',required:true,maxLength:100},{name:'quantity',label:'采购数量',type:'number',required:true,min:1,max:99999,step:1},{name:'amount',label:'金额',type:'number',required:true,min:.01,max:9999999.99,step:.01}]};

test('an empty draft remains empty instead of inventing required business fields',()=>{
  assert.deepEqual(collectWorkflowData(form({leaveType:'',reason:'  '}),leave),{});
  assert.throws(()=>collectWorkflowData(form({}),leave,{requireAll:true}),/请填写请假类型/);
});
test('only template fields are collected and submitted text is trimmed',()=>{
  const values={leaveType:'事假',startDate:'2026-11-20',endDate:'2026-11-21',reason:'  自有测试申请  ',owner:'someone-else',canReview:true};
  assert.deepEqual(collectWorkflowData(form(values),leave,{requireAll:true}),{leaveType:'事假',startDate:'2026-11-20',endDate:'2026-11-21',reason:'自有测试申请'});
});
test('calendar dates and date ordering are checked for drafts and submissions',()=>{
  for(const bad of ['2026-02-30','2026-2-03','not-a-date','2026-13-01'])assert.throws(()=>collectWorkflowData(form({startDate:bad}),leave),/有效的开始日期/);
  assert.throws(()=>collectWorkflowData(form({startDate:'2026-11-21',endDate:'2026-11-20'}),leave),/结束日期/);
  assert.equal(collectWorkflowData(form({startDate:'2028-02-29'}),leave).startDate,'2028-02-29');
});
test('amounts and counts use real bounded numbers with the correct precision',()=>{
  assert.deepEqual(collectWorkflowData(form({item:'试验设备',quantity:'2',amount:'1200.50'}),purchase,{requireAll:true}),{item:'试验设备',quantity:2,amount:1200.5});
  for(const bad of ['NaN','Infinity','-1','0','10000000','1.001'])assert.throws(()=>collectWorkflowData(form({amount:bad}),purchase),/金额/);
  for(const bad of ['0','1.5','100000'])assert.throws(()=>collectWorkflowData(form({quantity:bad}),purchase),/采购数量/);
});
test('unlisted select options and oversized fields are rejected without trusting arbitrary form values',()=>{
  assert.throws(()=>collectWorkflowData(form({leaveType:'直接批准'}),leave),/有效的请假类型/);
  assert.throws(()=>collectWorkflowData(form({reason:'字'.repeat(1001)}),leave),/最多1000字/);
  assert.throws(()=>collectWorkflowData(form({'__proto__':'x'}),{fields:[{name:'__proto__',type:'text'}]}),/字段配置/);
});
test('draft and application lists reflect server records without fabricated rows',()=>{
  const draft={id:'draft',status:'draft'},pending={id:'pending',status:'pending'},approved={id:'approved',status:'approved'},rejected={id:'rejected',status:'rejected'};
  const snapshot={requests:[draft,pending,approved,rejected],reviews:[]};
  assert.deepEqual(workflowList(snapshot,'drafts'),[draft]);assert.deepEqual(workflowList(snapshot,'mine'),[pending,approved,rejected]);
  assert.deepEqual(workflowList(null,'drafts'),[]);assert.deepEqual(workflowList(null,'reviews'),[]);
});
test('the review inbox only exposes pending entries explicitly marked reviewable',()=>{
  const allowed={id:'assigned',status:'pending',canReview:true};
  const snapshot={requests:[],reviews:[allowed,{id:'not-assigned',status:'pending',canReview:false},{id:'done',status:'approved',canReview:true},{id:'truthy-string',status:'pending',canReview:'true'}]};
  assert.deepEqual(workflowList(snapshot,'reviews'),[allowed]);
});
