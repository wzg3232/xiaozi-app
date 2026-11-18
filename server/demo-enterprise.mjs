// Fixed, fictional fixtures for product demonstrations. This module has no DB,
// environment, network or command access and never changes real module grants.
const sampleDate='2026-11-14';
const meta=Object.freeze({demo:true,sourceLabel:'模拟演示',sampleDate,timezone:'Asia/Shanghai',disclaimer:'示例数据，不作经营决策或设备操作依据'});
const metric=(label,value,unit,hint='固定样例')=>({label,value,unit,hint});
const load=[310,290,275,270,285,330,410,510,620,680,720,735,710,695,730,760,780,745,690,610,530,460,395,350];
const pv=[0,0,0,0,0,0,20,100,230,360,480,560,590,550,420,280,140,40,0,0,0,0,0,0];
const storage=[-120,-120,-120,-120,-80,-40,0,0,40,80,100,0,-60,-80,-40,0,80,120,160,160,120,80,0,0];
const predicted=[0.31,0.30,0.29,0.29,0.30,0.33,0.45,0.56,0.72,0.85,0.91,0.88,0.63,0.58,0.60,0.68,0.86,1.02,1.08,1.01,0.86,0.66,0.48,0.36];
const actual=[0.32,0.31,0.30,0.28,0.31,0.35,0.44,0.54,0.70,0.83,0.89,0.90,0.65,0.60,0.59,0.67,0.84,1.00,1.04,0.98,0.88,0.64,0.50,0.37];
const hour=index=>String(index).padStart(2,'0')+':00';
const sum=values=>values.reduce((total,value)=>total+value,0);
const round=value=>Math.round(value*100)/100;
const documents=[
  {id:'demo-storage-safety',title:'储能电站日常巡检示例',category:'储能运维',excerpt:'演示如何按电池、温控、消防与告警四类整理巡检记录。',content:'本页为虚构知识库样例。日常巡检可记录电池状态、温控运行、消防检查与告警复核。实际巡检标准、操作步骤和安全要求应以企业正式制度及设备厂商文件为准。',tags:['储能','巡检','运维'],updatedAt:'2026-11-10'},
  {id:'demo-tariff-primer',title:'峰谷电价与储能收益基础示例',category:'电价知识',excerpt:'通过虚构的峰、平、谷时段展示电价查询与知识检索。',content:'本页为固定演示资料。峰谷电价有助于理解不同时段的用能成本，储能策略仍需考虑效率、寿命、可用容量及适用规则。这里没有读取真实市场电价，不能据此下达交易或充放电指令。',tags:['电价','峰谷','储能','收益'],updatedAt:'2026-11-11'},
  {id:'demo-project-acceptance',title:'光伏项目验收资料清单示例',category:'项目管理',excerpt:'展示如何汇总设计资料、设备台账、测试记录与交付文件。',content:'本页为虚构的项目资料模板。示例目录包括设计说明、设备台账、测试记录、问题清单、整改记录与交付签字页；正式项目的验收要求由项目合同及适用制度确定。',tags:['光伏','验收','项目','交付'],updatedAt:'2026-11-12'},
  {id:'demo-office-process',title:'内部申请填写说明示例',category:'办公协同',excerpt:'区分申请草稿、提交待办、指定审批人与处理结果。',content:'本页是演示文档。申请可先保存草稿，实际提交需要明确企业成员和审批人配置。模拟业务页面不会代替真人审批，不会自动付款、采购下单或执行设备控制。',tags:['流程','请假','报销','审批'],updatedAt:'2026-11-13'}
];
const projects=[
  {id:'demo-south-storage',name:'南园区光储一体化示例',description:'虚构项目：从现场勘查到设备联调的完整节点展示',owner:'演示项目组',progress:72,status:'进行中',milestones:[{name:'现场勘查',date:'2026-11-02',status:'已完成'},{name:'方案确认',date:'2026-11-06',status:'已完成'},{name:'设备联调',date:'2026-11-18',status:'进行中'},{name:'项目验收',date:'2026-11-28',status:'待开始'}]},
  {id:'demo-north-energy',name:'北园区能源管理示例',description:'虚构项目：能耗采集、看板上线与试运行',owner:'演示项目组',progress:48,status:'进行中',milestones:[{name:'计量点梳理',date:'2026-11-04',status:'已完成'},{name:'数据采集',date:'2026-11-17',status:'进行中'},{name:'业务看板',date:'2026-11-23',status:'待开始'},{name:'试运行',date:'2026-12-02',status:'待开始'}]},
  {id:'demo-tariff-platform',name:'电价分析平台示例',description:'虚构项目：规则整理、样例验证与报告交付',owner:'演示项目组',progress:90,status:'进行中',milestones:[{name:'需求确认',date:'2026-10-28',status:'已完成'},{name:'样例验证',date:'2026-11-08',status:'已完成'},{name:'报告交付',date:'2026-11-18',status:'进行中'}]}
];
function matches(query,parts){
  const terms=query.toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean),haystack=parts.join(' ').toLocaleLowerCase('zh-CN');
  return terms.every(term=>haystack.includes(term));
}
function demoData(id,query){
  if(id==='energy')return {
    metrics:[metric('园区用电量',sum(load),'kWh'),metric('光伏发电量',sum(pv),'kWh'),metric('储能放电量',sum(storage.filter(value=>value>0)),'kWh'),metric('储能 SOC',68,'%')],
    series:load.map((value,index)=>({hour:hour(index),loadKw:value,pvKw:pv[index],storageKw:storage[index]})),
    devices:[{name:'光伏逆变器组（示例）',status:'运行中'},{name:'储能电池组（示例）',status:'待机'},{name:'园区计量网关（示例）',status:'运行中'}],
    units:{power:'kW',energy:'kWh',soc:'%'},sampleDate,intervalMinutes:60
  };
  if(id==='prices')return {
    metrics:[metric('样例预测均价',round(sum(predicted)/24),'元/kWh'),metric('样例预测最高价',Math.max(...predicted),'元/kWh'),metric('样例预测最低价',Math.min(...predicted),'元/kWh'),metric('样例峰谷价差',round(Math.max(...predicted)-Math.min(...predicted)),'元/kWh')],
    unit:'元/kWh',forecastDate:sampleDate,historyDate:'2026-11-13',
    series:predicted.map((value,index)=>({hour:hour(index),predicted:value,actual:actual[index],band:index<6||index>=22?'谷':[9,10,11,17,18,19,20].includes(index)?'峰':'平'})),
    strategies:[{title:'谷段充电示例',period:'00:00–06:00',description:'展示低价时段策略，仅为样例，不发送设备指令。'},{title:'峰段放电示例',period:'17:00–20:00',description:'展示高价时段对比，不代表实际市场规则或可执行计划。'}]
  };
  if(id==='knowledge'){
    const found=documents.filter(doc=>matches(query,[doc.title,doc.category,doc.excerpt,doc.content,...doc.tags]));
    return {query,total:found.length,documents:found};
  }
  if(id==='projects'){
    const found=projects.filter(project=>matches(query,[project.name,project.description,...project.milestones.map(milestone=>milestone.name)]));
    return {query,metrics:[metric('示例项目数',found.length,'个'),metric('平均进度',found.length?round(sum(found.map(project=>project.progress))/found.length):0,'%')],projects:found};
  }
  return null;
}
export function createDemoEnterprise({json,fail}){
  return {handle(req,res,url){
    const route=url.pathname.match(/^\/api\/enterprise\/demo\/modules\/([a-z]+)$/);if(!route)return false;
    if(req.method!=='GET'){res.setHeader('Allow','GET');throw fail(405,'模拟演示仅支持查看，不执行业务操作');}
    const query=(url.searchParams.get('q')||'').trim();if(query.length>120)throw fail(400,'演示查询最多 120 个字');
    const data=demoData(route[1],query);if(!data)throw fail(404,'演示模块不存在');
    json(res,200,{moduleId:route[1],mode:'demo',isDemo:true,meta,data});return true;
  }};
}
