const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>!['number','string'].includes(typeof value)||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const display=value=>value===null||value===undefined||value===''?'—':typeof value==='number'?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(value):String(value);

// Presentation copy applies only to the application's fixed fixtures. Enterprise
// source records and user-authored text are passed through unchanged.
const documentCopy={
  'demo-storage-safety':{title:'储能电站日常巡检',excerpt:'按电池、温控、消防与告警四类整理巡检记录。',content:'电池状态\n记录电池组运行状态、温度、SOC 与异常情况，便于跟踪状态变化。\n\n温控与消防\n记录温控系统运行情况、消防设施检查结果和需要跟进的问题。\n\n告警复核\n记录告警发生时间、影响范围、复核结果、处理责任人与后续跟进节点。\n\n巡检归档\n按日期保存巡检记录，汇总待处理事项，并在完成后补充处理记录。'},
  'demo-tariff-primer':{title:'峰谷电价与储能收益基础',excerpt:'整理峰、平、谷时段与储能收益分析的常用指标。',content:'时段划分\n将电价按峰、平、谷时段汇总，比较不同时段的用能成本。\n\n收益分析\n结合充放电量、电价差、转换效率与电池使用成本，整理储能收益测算。\n\n结果跟踪\n按日期保留测算依据，对比计划与执行结果，持续更新成本和收益记录。'},
  'demo-project-acceptance':{title:'光伏项目验收资料清单',excerpt:'汇总设计资料、设备台账、测试记录与交付文件。',content:'设计资料\n整理设计说明、图纸版本和设计变更记录。\n\n设备与测试\n汇总设备台账、安装记录、测试记录和调试报告。\n\n问题闭环\n逐项登记问题、责任人、整改期限与复核结果。\n\n交付归档\n归集验收记录、交付签字页和移交文件，并记录最终资料版本。'},
  'demo-office-process':{title:'内部申请填写说明',excerpt:'整理申请草稿、提交待办、审批人与处理结果。',content:'填写申请\n选择请假、出差、报销或采购流程，填写日期、金额、原因等对应信息。\n\n保存草稿\n尚未填写完成的申请可保存为草稿，稍后继续编辑。\n\n提交与处理\n提交前核对申请内容。提交后的申请可在“我的申请”中查看状态，审批人在“待我处理”中处理分配的申请。\n\n查询记录\n申请详情保留提交、撤回和审批处理记录，方便跟踪进度。'}
};
const projectCopy={
  'demo-south-storage':{name:'南园区光储一体化',description:'现场勘查、方案确认、设备联调与项目验收',owner:'光储项目组'},
  'demo-north-energy':{name:'北园区能源管理',description:'能耗采集、业务看板上线与试运行',owner:'能源管理项目组'},
  'demo-tariff-platform':{name:'电价分析平台',description:'需求确认、数据验证与分析报告交付',owner:'电价分析项目组'}
};
const metricLabels={'样例预测均价':'预测均价','样例预测最高价':'预测最高价','样例预测最低价':'预测最低价','样例峰谷价差':'峰谷价差','示例项目数':'项目数量'};
const deviceNames={'光伏逆变器组（示例）':'光伏逆变器组','储能电池组（示例）':'储能电池组','园区计量网关（示例）':'园区计量网关'};
function presentDocument(document){return documentCopy[document?.id]?{...document,...documentCopy[document.id]}:document;}
export function presentBusinessData(result,{mode='enterprise'}={}){
  if(mode!=='demo'||result?.isDemo!==true||!result.data||typeof result.data!=='object')return result?.data;
  const data=result.data;
  return {...data,
    ...(Array.isArray(data.metrics)?{metrics:data.metrics.map(item=>({...item,label:metricLabels[item.label]||item.label,hint:''}))}:{}),
    ...(Array.isArray(data.devices)?{devices:data.devices.map(item=>({...item,name:deviceNames[item.name]||item.name}))}:{}),
    ...(Array.isArray(data.documents)?{documents:data.documents.map(presentDocument)}:{}),
    ...(Array.isArray(data.projects)?{projects:data.projects.map(item=>projectCopy[item.id]?{...item,...projectCopy[item.id],milestones:(item.milestones||[]).map(milestone=>milestone.name==='样例验证'?{...milestone,name:'数据验证'}:milestone)}:item)}:{}),
    ...(Array.isArray(data.strategies)?{strategies:data.strategies.map((item,index)=>({...item,...(index===0?{title:'谷段充电',description:'结合低价时段安排充电计划，跟踪用能成本与储能可用容量。'}:index===1?{title:'峰段放电',description:'比较高价时段的负荷与储能出力，整理峰谷时段收益分析。'}:{})}))}:{})
  };
}

export function chartGeometry(rows,keys,{width=600,height=150}={}){
  const source=Array.isArray(rows)?rows.slice(0,96):[];
  const values=source.flatMap(row=>keys.map(key=>number(row?.[key]))).filter(value=>value!==null);
  if(!source.length||!values.length)return null;
  const min=Math.min(0,...values),max=Math.max(1,...values),range=max-min;
  const lines=keys.map(key=>({key,points:source.map((row,index)=>{const value=number(row?.[key]);return value===null?null:{x:source.length===1?width/2:index/(source.length-1)*width,y:height-(value-min)/range*height,value};}).filter(Boolean)}));
  return {width,height,min,max,lines,labels:source.map(row=>String(row.hour??''))};
}

function chart(rows,series,unit,title){
  const geometry=chartGeometry(rows,series.map(item=>item.key));if(!geometry)return '<p class="data-empty">数据源未提供可绘制的时间序列。</p>';
  const {width,height}=geometry;
  return `<section class="data-chart"><div class="data-section-title"><h3>${esc(title)}</h3><span>${esc(unit)}</span></div><div class="data-chart-legend">${series.map(item=>`<span><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('')}</div><svg class="enterprise-line-chart" viewBox="0 0 650 205" role="img" aria-label="${esc(title)}，单位${esc(unit)}"><g transform="translate(35,12)">${[0,.5,1].map(fraction=>`<line x1="0" y1="${height*fraction}" x2="${width}" y2="${height*fraction}" stroke="#eee7f2" stroke-dasharray="3 5"/><text x="-7" y="${height*fraction+3}" text-anchor="end">${esc(display(geometry.max-(geometry.max-geometry.min)*fraction))}</text>`).join('')}${geometry.lines.map((line,index)=>`<polyline points="${line.points.map(point=>point.x.toFixed(2)+','+point.y.toFixed(2)).join(' ')}" fill="none" stroke="${series[index].color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}${geometry.labels.map((label,index)=>index===0||index===geometry.labels.length-1||index%4===0?`<text x="${geometry.labels.length===1?width/2:index/(geometry.labels.length-1)*width}" y="${height+25}" text-anchor="middle">${esc(label)}</text>`:'').join('')}</g></svg></section>`;
}
function metrics(items){
  if(!Array.isArray(items)||!items.length)return '';
  return `<div class="data-metrics">${items.slice(0,8).map(item=>`<article><small>${esc(item.label)}</small><p><b>${esc(display(item.value))}</b><span>${esc(item.unit||'')}</span></p>${item.hint?`<em>${esc(item.hint)}</em>`:''}</article>`).join('')}</div>`;
}
function hourlyTable(rows,columns){
  if(!Array.isArray(rows)||!rows.length)return '';
  return `<details class="data-hourly"><summary>查看逐小时数据</summary><div class="data-table-scroll"><table><thead><tr>${columns.map(column=>`<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,96).map(row=>`<tr>${columns.map(column=>`<td>${esc(display(row[column.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
function energy(data){
  return metrics(data.metrics)+chart(data.series,[{key:'loadKw',label:'用能负荷',color:'#9460b0'},{key:'pvKw',label:'光伏出力',color:'#73b9ab'},{key:'storageKw',label:'储能功率',color:'#b5a3d9'}],data.units?.power||'kW','日内功率曲线')+hourlyTable(data.series,[{key:'hour',label:'时刻'},{key:'loadKw',label:'负荷 kW'},{key:'pvKw',label:'光伏 kW'},{key:'storageKw',label:'储能 kW'}])+(Array.isArray(data.devices)?`<section class="data-devices"><div class="data-section-title"><h3>设备状态</h3></div>${data.devices.map(device=>`<div><span>${esc(device.name)}</span><b>${esc(device.status)}</b></div>`).join('')}</section>`:'');
}
function prices(data){
  return metrics(data.metrics)+chart(data.series,[{key:'predicted',label:'24 小时预测',color:'#9460b0'},{key:'actual',label:'前一日价格',color:'#9db3d3'}],data.unit||'元/kWh','24 小时电价预测')+`<p class="data-source-dates">${data.forecastDate?'预测日期：'+esc(data.forecastDate):''}${data.historyDate?' · 对照日期：'+esc(data.historyDate):''}</p>`+hourlyTable(data.series,[{key:'hour',label:'时刻'},{key:'predicted',label:'预测 元/kWh'},{key:'actual',label:'前一日 元/kWh'},{key:'band',label:'峰谷时段'}])+(Array.isArray(data.strategies)?`<section class="data-strategies"><div class="data-section-title"><h3>峰谷时段</h3></div>${data.strategies.map(item=>`<article><div><b>${esc(item.title)}</b><small>${esc(item.period)}</small></div><p>${esc(item.description)}</p></article>`).join('')}</section>`:'');
}
function knowledge(data,mode){
  const documents=Array.isArray(data.documents)?data.documents:[];
  return `<div class="data-section-title"><h3>${data.query?'搜索结果':'知识文档'}</h3><span>${documents.length} 份</span></div>${documents.length?`<div class="knowledge-documents">${documents.map(document=>`<article><div><span>${esc(document.category||'资料')}</span>${document.updatedAt?`<small>更新时间 ${esc(document.updatedAt)}</small>`:''}</div><h3>${esc(document.title)}</h3><p>${esc(document.excerpt||'')}</p><div class="knowledge-tags">${(Array.isArray(document.tags)?document.tags:[]).map(tag=>`<span>${esc(tag)}</span>`).join('')}</div><button data-manage="document" data-document="${esc(document.id)}">查看文档正文 <span>›</span></button></article>`).join('')}</div>`:`<div class="data-empty"><h3>没有找到匹配资料</h3></div>`}`;
}
function projects(data,mode){
  const items=Array.isArray(data.projects)?data.projects:[];
  return metrics(data.metrics)+`<div class="data-section-title"><h3>${data.query?'项目搜索结果':'项目进度'}</h3><span>${items.length} 项</span></div>${items.length?`<div class="data-projects">${items.map(project=>{
    const progress=number(project.progress),percent=progress===null?null:Math.max(0,Math.min(100,progress));
    return `<article><div class="data-project-heading"><h3>${esc(project.name)}</h3><span>${esc(project.status||'未提供状态')}</span></div><p>${esc(project.description||'')}</p><div class="data-project-owner"><span>${esc(project.owner||'未提供负责人')}</span><b>${percent===null?'未提供进度':esc(display(percent))+'%'}</b></div>${percent!==null?`<div class="data-progress" role="progressbar" aria-label="${esc(project.name)}进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div>`:''}<div class="project-milestones">${(Array.isArray(project.milestones)?project.milestones:[]).map(item=>`<div class="${item.status==='已完成'?'done':item.status==='进行中'?'active':'todo'}"><i></i><span><b>${esc(item.name)}</b><small>${esc(item.date)} · ${esc(item.status)}</small></span></div>`).join('')}</div></article>`;
  }).join('')}</div>`:'<div class="data-empty"><h3>没有找到匹配项目</h3><p>请调整搜索关键词。</p></div>'}`;
}

export function readableBusinessValue(value,{depth=0}={}){
  if(value===null||value===undefined)return '<p class="data-empty">数据源未提供内容。</p>';
  if(typeof value!=='object')return `<p class="data-readable-text">${esc(display(value))}</p>`;
  if(depth>3)return '<p class="data-readable-text">包含更多明细，请在业务系统查看。</p>';
  if(Array.isArray(value))return value.length?`<div class="data-readable-list">${value.slice(0,50).map(item=>`<article>${readableBusinessValue(item,{depth:depth+1})}</article>`).join('')}</div>`:'<p class="data-empty">暂无匹配记录。</p>';
  const labels={name:'名称',title:'标题',status:'状态',value:'数值',unit:'单位',description:'说明',content:'内容',owner:'负责人',updatedAt:'更新时间',date:'日期',message:'信息',total:'总数',amount:'金额',progress:'进度'};
  return `<dl class="data-readable-fields">${Object.entries(value).slice(0,30).map(([key,item])=>`<div><dt>${esc(labels[key]||key)}</dt><dd>${typeof item==='object'?readableBusinessValue(item,{depth:depth+1}):esc(display(item))}</dd></div>`).join('')}</dl>`;
}
export function renderBusinessData(result,{moduleId,mode='enterprise'}={}){
  const data=presentBusinessData(result,{mode});
  if(!data||typeof data!=='object')return readableBusinessValue(data);
  if(moduleId==='energy'&&(Array.isArray(data.metrics)||Array.isArray(data.series)))return energy(data);
  if(moduleId==='prices'&&Array.isArray(data.series))return prices(data,mode);
  if(moduleId==='knowledge'&&Array.isArray(data.documents))return knowledge(data,mode);
  if(moduleId==='projects'&&Array.isArray(data.projects))return projects(data,mode);
  return readableBusinessValue(data);
}
export function renderKnowledgeDocument(document,{mode='enterprise'}={}){
  if(!document)return '<p class="data-empty">此文档暂时不可用，请重新搜索。</p>';
  if(mode==='demo')document=presentDocument(document);
  return `<article class="knowledge-document-reader"><span>${esc(document.category||'企业文档')}</span><h3>${esc(document.title)}</h3><p class="knowledge-document-meta">${document.updatedAt?esc(document.updatedAt):''}</p><div>${esc(document.content||document.excerpt||'数据源未提供正文。')}</div></article>`;
}
