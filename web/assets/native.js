const pending=new Map();let nextId=0;
export const isNative=!!window.iChatNative?.postMessage;
function nativeRequest(action,payload={},timeout=120000){
  if(!isNative)return Promise.reject(Error('这个功能需要在安卓客户端使用'));
  return new Promise((resolve,reject)=>{const id='native_'+Date.now()+'_'+(++nextId),timer=setTimeout(()=>{pending.delete(id);reject(Error('操作等待超时，请重试'));},timeout);pending.set(id,{resolve,reject,timer});try{window.iChatNative.postMessage(JSON.stringify({id,action,payload}));}catch{clearTimeout(timer);pending.delete(id);reject(Error('手机功能暂时无法调用，请重新打开应用'));}});
}
window.addEventListener('ichat-native-result',event=>{const result=event.detail;if(!result||typeof result.id!=='string')return;const request=pending.get(result.id);if(!request)return;pending.delete(result.id);clearTimeout(request.timer);if(result.ok)request.resolve(result.data);else request.reject(Error(typeof result.error==='string'?result.error:'手机操作未完成'));});
async function browserPermission(name){try{return (await navigator.permissions.query({name})).state;}catch{return 'prompt';}}
export async function getPermissionState(){
  if(isNative)return nativeRequest('getPermissionState',{},10000);
  const [camera,microphone,location]=await Promise.all(['camera','microphone','geolocation'].map(browserPermission));
  return {camera,microphone,location,notifications:typeof Notification==='undefined'?'denied':Notification.permission,notificationsActive:false};
}
export async function requestPermission(name){
  if(isNative)return nativeRequest('requestPermission',{name});
  if(name==='notifications'){if(typeof Notification==='undefined')throw Error('当前浏览器不支持通知');await Notification.requestPermission();return getPermissionState();}
  if(name==='location'){await getLocation();return getPermissionState();}
  if(!['camera','microphone'].includes(name))throw Error('这个权限无需单独开启，请使用对应的系统选择器');
  if(!navigator.mediaDevices?.getUserMedia)throw Error('当前浏览器不支持这个功能，请使用安卓客户端或 HTTPS 页面');
  const stream=await navigator.mediaDevices.getUserMedia(name==='camera'?{video:true}:{audio:true});stream.getTracks().forEach(track=>track.stop());return getPermissionState();
}
export async function openSystemSettings(){if(isNative)return nativeRequest('openSystemSettings');throw Error('请在浏览器的站点设置中管理权限');}
export async function pickContact(){
  if(isNative)return nativeRequest('pickContact');
  if(!navigator.contacts?.select)throw Error('请在安卓客户端选择手机联系人，也可以直接输入对方的手机号');
  const contacts=await navigator.contacts.select(['name','tel'],{multiple:false});if(!contacts.length)throw Error('已取消选择');return {name:contacts[0].name?.[0]||'',phone:contacts[0].tel?.[0]||''};
}
export async function getLocation(){
  if(isNative)return nativeRequest('getLocation',{},90000);
  if(!navigator.geolocation)throw Error('当前设备不支持定位');
  return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(position=>resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy}),error=>reject(Error(error.code===1?'定位权限未开启':error.code===3?'定位超时，请到信号较好的地方重试':'暂时无法获取当前位置')),{enableHighAccuracy:false,timeout:18000,maximumAge:0}));
}
export async function downloadMedia({base,token,id,filename}){
  if(isNative)return nativeRequest('downloadMedia',{base,token,id,filename},180000);
  const url=new URL(base);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||!/^[a-f0-9-]{36}$/.test(id))throw Error('文件地址不正确');
  const response=await fetch(url.origin+'/api/media/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('文件无法读取，请检查登录状态后重试');if(Number(response.headers.get('Content-Length'))>12*1024*1024)throw Error('文件超过下载大小限制');
  const blob=await response.blob();if(blob.size>12*1024*1024)throw Error('文件超过下载大小限制');const objectUrl=URL.createObjectURL(blob),link=document.createElement('a');link.href=objectUrl;link.download=String(filename||'小紫在文件').replace(/[\x00-\x1f/\\]/g,'_').slice(0,120);link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);return {saved:true,filename:link.download};
}
export const startNotifications=options=>nativeRequest('startNotifications',options);
export const messageAlert=options=>nativeRequest('messageAlert',options,5000);
export async function stopNotifications(){if(isNative)return nativeRequest('stopNotifications',{},10000);return {stopped:true};}
export async function setCallActive(active){if(isNative)return nativeRequest('setCallActive',{active:!!active},10000);return {active:!!active};}
