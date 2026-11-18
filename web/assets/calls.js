import {setCallActive} from './native.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(20)),x=>x.toString(16).padStart(2,'0')).join('');
const endReasons={rejected:'对方暂时不方便接听',missed:'对方未接听',hangup:'通话已结束',disconnected:'连接中断，通话已结束','session-ended':'通话已结束',timeout:'本次通话已结束','server-restart':'服务正在重连，通话已结束'};
const assetUrl=name=>{const url=new URL(name,import.meta.url);url.search=new URL(import.meta.url).search;return url.href;};
function bytesToBase64(bytes){let result='';for(let offset=0;offset<bytes.length;offset+=8192)result+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(result);}

export function createCallController({getSession,getSocket,notify}){
  const css=document.createElement('link');css.rel='stylesheet';css.href=assetUrl('./calls.css');document.head.append(css);
  const dialog=document.createElement('dialog');dialog.className='ichat-call-dialog';dialog.setAttribute('aria-label','小紫在 通话');document.body.append(dialog);
  let call=null,stream=null,context=null,capture=null,source=null,silent=null,videoTimer=null,tick=null,generation=0,ready=false,microphoneMuted=false,videoEnabled=true,nextPlayback=0,sessionToken=null,localClientId=null;
  const sameSession=()=>!!call&&sessionToken===getSession()?.token;
  const me=()=>getSession()?.user?.id;
  const incoming=()=>call?.callee?.id===me();
  const peer=()=>incoming()?call?.caller:call?.callee;
  function send(event){const socket=getSocket();if(!socket||socket.readyState!==1)throw Error('消息连接暂时不可用，请稍后重试');socket.send(JSON.stringify(event));}
  function cleanup(){
    generation++;clearInterval(videoTimer);clearInterval(tick);videoTimer=tick=null;ready=false;stream?.getTracks().forEach(track=>track.stop());stream=null;
    try{if(capture?.port)capture.port.onmessage=null;if(capture?.onaudioprocess)capture.onaudioprocess=null;source?.disconnect();capture?.disconnect();silent?.disconnect();context?.close().catch(()=>{});}catch{}
    source=capture=silent=context=null;nextPlayback=0;call=null;sessionToken=null;localClientId=null;if(dialog.open)dialog.close();dialog.innerHTML='';setCallActive(false).catch(()=>{});
  }
  function durationText(){if(!call?.startedAt)return '';const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(call.startedAt))/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  function updateStatus(){if(!call)return;const text=call.state==='active'?durationText():call.state==='preparing'?'正在准备通话…':incoming()?'邀请你'+(call.mode==='video'?'视频':'语音')+'通话':'正在等待对方接听…';const status=dialog.querySelector('.call-status');if(status)status.textContent=text;}
  function render(){
    if(!call)return;const who=peer();const active=call.state==='active',ringing=call.state==='ringing',answer=incoming()&&ringing;
    dialog.innerHTML=`<div class="call-stage ${call.mode==='video'?'with-video':''}"><div class="call-remote"><img alt="对方的视频画面" hidden><div class="call-avatar">${esc(Array.from(who?.displayName||'?')[0])}</div><span class="call-video-note"></span></div><video class="call-self" muted autoplay playsinline ${call.mode==='video'?'':'hidden'}></video><div class="call-heading"><span>小紫在 ${call.mode==='video'?'视频':'语音'}通话</span><h2>${esc(who?.displayName||'朋友')}</h2><p class="call-status" aria-live="polite"></p><small class="call-peer-mute" hidden>对方已静音</small></div><div class="call-controls">${answer?'<button data-call="reject" class="call-circle call-end">拒绝</button><button data-call="answer" class="call-circle call-accept">接听</button>':`<button data-call="mute" class="call-circle" ${active?'':'disabled'} aria-pressed="${microphoneMuted}">${microphoneMuted?'取消静音':'静音'}</button>${call.mode==='video'?`<button data-call="camera" class="call-circle" ${active?'':'disabled'}>${videoEnabled?'关闭视频':'打开视频'}</button>`:''}<button data-call="end" class="call-circle call-end">${active?'挂断':'取消'}</button>`}</div><div class="call-leave-confirm" hidden><p>要结束本次通话吗？</p><button data-call="stay">继续通话</button><button data-call="end" class="call-end">结束通话</button></div></div>`;
    const self=dialog.querySelector('.call-self');if(stream&&self&&!self.hidden){self.srcObject=stream;self.play().catch(()=>{});}if(!dialog.open)dialog.showModal();updateStatus();clearInterval(tick);tick=setInterval(updateStatus,1000);setCallActive(true).catch(()=>{});
  }
  function forwardAudio(samples,rate){
    if(!sameSession()||call.state!=='active'||microphoneMuted)return;const socket=getSocket();if(!socket||socket.readyState!==1||socket.bufferedAmount>128*1024)return;
    const ratio=rate/16000,length=Math.floor(samples.length/ratio),bytes=new Uint8Array(length*2),view=new DataView(bytes.buffer);if(!length||bytes.length>4096)return;
    for(let i=0;i<length;i++){const start=Math.floor(i*ratio),end=Math.max(start+1,Math.floor((i+1)*ratio));let value=0;for(let j=start;j<Math.min(end,samples.length);j++)value+=samples[j];value/=end-start;value=Math.max(-1,Math.min(1,value));view.setInt16(i*2,value<0?value*32768:value*32767,true);}
    socket.send(JSON.stringify({type:'call-frame',callId:call.id,kind:'audio',data:bytesToBase64(bytes),sampleRate:16000}));
  }
  async function prepareMedia(ticket){
    if(!navigator.mediaDevices?.getUserMedia)throw Error('此设备暂不支持通话，请使用安卓客户端或 HTTPS 页面');
    const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)throw Error('此设备暂不支持语音通话');
    try{context=new AudioCtx({sampleRate:16000});}catch{context=new AudioCtx();}const ownedContext=context;ownedContext.resume().catch(()=>{});
    const obtained=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:{ideal:16000}},video:call.mode==='video'?{width:{ideal:320},height:{ideal:240},frameRate:{ideal:6,max:8},facingMode:'user'}:false});
    if(ticket!==generation||!sameSession()){obtained.getTracks().forEach(track=>track.stop());throw Error('通话已取消');}stream=obtained;
    obtained.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(ticket===generation&&call){notify('麦克风或摄像头已断开');hangup();}}));
    source=ownedContext.createMediaStreamSource(obtained);silent=ownedContext.createGain();silent.gain.value=0;
    if(ownedContext.audioWorklet&&window.AudioWorkletNode){await ownedContext.audioWorklet.addModule(assetUrl('./audio-capture.js'));if(ticket!==generation||!sameSession())throw Error('通话已取消');capture=new AudioWorkletNode(ownedContext,'ichat-pcm-capture');capture.port.onmessage=event=>{if(ticket===generation)forwardAudio(event.data,ownedContext.sampleRate);};}
    else{capture=ownedContext.createScriptProcessor(2048,1,1);capture.onaudioprocess=event=>{if(ticket===generation)forwardAudio(event.inputBuffer.getChannelData(0),ownedContext.sampleRate);};}
    source.connect(capture);capture.connect(silent);silent.connect(ownedContext.destination);ready=true;
    const local=dialog.querySelector('.call-self');if(local&&call.mode==='video'){local.srcObject=stream;await local.play().catch(()=>{});}return obtained;
  }
  function startVideo(){
    clearInterval(videoTimer);if(call?.mode!=='video')return;const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    videoTimer=setInterval(()=>{if(!sameSession()||call.state!=='active'||!videoEnabled)return;const video=dialog.querySelector('.call-self'),socket=getSocket();if(!video?.videoWidth||!socket||socket.readyState!==1||socket.bufferedAmount>128*1024)return;const scale=Math.min(1,320/video.videoWidth,240/video.videoHeight);canvas.width=Math.max(1,Math.floor(video.videoWidth*scale));canvas.height=Math.max(1,Math.floor(video.videoHeight*scale));ctx.drawImage(video,0,0,canvas.width,canvas.height);let data=canvas.toDataURL('image/jpeg',.45).split(',')[1];if(data.length>Math.ceil(40*1024/3)*4)data=canvas.toDataURL('image/jpeg',.2).split(',')[1];if(data.length<=Math.ceil(40*1024/3)*4)socket.send(JSON.stringify({type:'call-frame',callId:call.id,kind:'video',data,width:canvas.width,height:canvas.height}));},200);
  }
  function playback(event){
    if(!sameSession()||call.state!=='active'||event.callId!==call.id||!ready)return;
    if(event.kind==='video'){if(call.mode!=='video'||typeof event.data!=='string'||event.data.length>56000)return;const image=dialog.querySelector('.call-remote>img');if(image){image.src='data:image/jpeg;base64,'+event.data;image.hidden=false;dialog.querySelector('.call-avatar').hidden=true;dialog.querySelector('.call-video-note').textContent='';}return;}
    if(event.kind!=='audio'||event.sampleRate!==16000||typeof event.data!=='string'||event.data.length>5464||!context||context.state==='closed')return;
    try{const raw=atob(event.data);if(!raw.length||raw.length%2)return;const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,16000),output=buffer.getChannelData(0);for(let i=0;i<output.length;i++)output[i]=view.getInt16(i*2,true)/32768;const audio=context.createBufferSource();audio.buffer=buffer;audio.connect(context.destination);if(nextPlayback<context.currentTime||nextPlayback>context.currentTime+.4)nextPlayback=context.currentTime+.035;audio.start(nextPlayback);nextPlayback+=buffer.duration;}catch{}
  }
  async function start(who,mode='audio'){
    if(call){notify('请先结束当前通话');return;}const session=getSession();if(!session?.token||!who?.id||who.id===session.user?.id)return;if(!['audio','video'].includes(mode))return;
    call={id:null,mode,caller:session.user,callee:who,state:'preparing'};sessionToken=session.token;microphoneMuted=false;videoEnabled=true;localClientId=uid();const ticket=++generation;render();
    try{await prepareMedia(ticket);if(ticket!==generation||!sameSession())return;send({type:'call-start',peerId:who.id,mode,clientId:localClientId});}
    catch(error){if(ticket===generation){cleanup();notify(mediaError(error));}}
  }
  function mediaError(error){return error?.name==='NotAllowedError'?'请允许麦克风或相机权限后重试':error?.name==='NotFoundError'?'未找到麦克风或摄像头，请检查设备设置':error?.name==='NotReadableError'?'无法启动麦克风或摄像头，请检查设备连接和权限':error?.message||'暂时无法准备通话';}
  async function answer(){
    if(!call||call.state!=='ringing'||!incoming())return;const id=call.id,ticket=++generation;const button=dialog.querySelector('[data-call=answer]');if(button)button.disabled=true;
    try{await prepareMedia(ticket);if(ticket!==generation||!sameSession()||call.id!==id)return;send({type:'call-answer',callId:id,accept:true});}
    catch(error){if(ticket===generation){try{send({type:'call-answer',callId:id,accept:false});}catch{}cleanup();notify(mediaError(error));}}
  }
  function hangup(){if(!call)return;const id=call.id;try{if(id)send({type:'call-end',callId:id});}catch{}cleanup();}
  function handleEvent(event){
    if(event.type==='call-error'){if(call&&(!event.callId||event.callId===call.id)&&(!event.clientId||event.clientId===localClientId)){cleanup();notify(event.message||'通话未能连接');}return;}
    if(event.type==='call-frame'){playback(event);return;}
    if(event.type==='call-control'){if(!call||call.id!==event.callId)return;const label=dialog.querySelector('.call-peer-mute');if(label)label.hidden=!event.microphoneMuted;if(event.videoEnabled===false){const img=dialog.querySelector('.call-remote>img');if(img)img.hidden=true;dialog.querySelector('.call-avatar').hidden=false;dialog.querySelector('.call-video-note').textContent='对方暂停了视频';}return;}
    if(event.type!=='call-state'||!event.call||![event.call.caller?.id,event.call.callee?.id].includes(me()))return;
    const next=event.call;if(next.state==='ended'){if(call?.id===next.id){cleanup();notify(endReasons[next.reason]||'通话已结束');}return;}
    if(call?.id&&call.id!==next.id)return;
    if(call&&!sameSession()){cleanup();return;}
    if(next.state==='active'&&!ready){if(call?.id===next.id)cleanup();return;}
    if(!call){if(next.state!=='ringing'||next.callee.id!==me())return;sessionToken=getSession().token;microphoneMuted=false;videoEnabled=true;generation++;}
    const wasActive=call?.state==='active';call=next;render();if(call.state==='active'&&!wasActive)startVideo();
  }
  dialog.addEventListener('click',event=>{const button=event.target.closest('[data-call]');if(!button||button.disabled)return;const action=button.dataset.call;if(action==='answer')answer();else if(action==='reject'){try{send({type:'call-answer',callId:call.id,accept:false});}catch{}cleanup();}else if(action==='end')hangup();else if(action==='stay')dialog.querySelector('.call-leave-confirm').hidden=true;else if(action==='mute'||action==='camera'){if(!call||!ready)return;if(action==='mute'){microphoneMuted=!microphoneMuted;stream.getAudioTracks().forEach(track=>track.enabled=!microphoneMuted);button.textContent=microphoneMuted?'取消静音':'静音';button.setAttribute('aria-pressed',String(microphoneMuted));}else{videoEnabled=!videoEnabled;stream.getVideoTracks().forEach(track=>track.enabled=videoEnabled);button.textContent=videoEnabled?'关闭视频':'打开视频';}try{send({type:'call-control',callId:call.id,microphoneMuted,videoEnabled});}catch{}}});
  const confirmLeave=()=>{const panel=dialog.querySelector('.call-leave-confirm');if(panel)panel.hidden=false;};
  dialog.addEventListener('cancel',event=>{event.preventDefault();confirmLeave();});
  window.addEventListener('ichat-back',event=>{if(call&&dialog.open){event.preventDefault();confirmLeave();}},{capture:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&call){hangup();notify('已离开通话页面，本次通话结束');}});
  window.addEventListener('pagehide',hangup);
  return {start,handleEvent,reset:cleanup,connectionClosed(){if(call){cleanup();notify('连接中断，通话已结束');}},restore(value){if(value)handleEvent({type:'call-state',call:value});},isActive:()=>!!call};
}
