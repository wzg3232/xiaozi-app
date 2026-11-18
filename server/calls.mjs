import {randomUUID} from 'node:crypto';

// A bounded foreground media relay over the app's existing authenticated WSS.
// No recordings, external ICE service, unbounded buffers or new public ports.
export function createCallHub({publicUser,canCall,notify,onEnded=()=>{},isSocketValid=()=>false,ringMs=35000,maxCalls=4,now=Date.now}){
  const calls=new Map(),byUser=new Map(),starts=new Map();
  const valid=ws=>!!ws&&ws.readyState===1&&isSocketValid(ws);
  const view=call=>({id:call.id,mode:call.mode,caller:publicUser(call.callerId),callee:publicUser(call.calleeId),state:call.state,reason:call.reason||null,createdAt:call.createdAt,startedAt:call.startedAt||null,endedAt:call.endedAt||null});
  const emit=(id,event)=>{try{notify(id,event);}catch{}};
  const publish=call=>{const event={type:'call-state',call:view(call)};emit(call.callerId,event);emit(call.calleeId,event);};
  const error=(ws,message,source={})=>{if(valid(ws))ws.send(JSON.stringify({type:'call-error',message,...(source.callId?{callId:source.callId}:{}),...(source.clientId?{clientId:source.clientId}:{})}));};
  function finish(call,reason){
    if(!call||!calls.has(call.id))return;
    call.state='ended';call.reason=reason;call.endedAt=new Date(now()).toISOString();
    calls.delete(call.id);byUser.delete(call.callerId);byUser.delete(call.calleeId);publish(call);
    const durationMs=call.startedAt?Math.max(0,now()-Date.parse(call.startedAt)):0;
    try{onEnded({id:call.id,callerId:call.callerId,calleeId:call.calleeId,mode:call.mode,reason,durationMs,durationSeconds:Math.floor(durationMs/1000),createdAt:call.createdAt,startedAt:call.startedAt||null,endedAt:call.endedAt});}catch(e){console.error('Call summary could not be stored:',e.message);}
  }
  function decode(value,max){
    if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||!value.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return null;
    const bytes=Buffer.from(value,'base64');return bytes.length<=max&&bytes.toString('base64')===value?bytes:null;
  }
  function jpegDimensions(bytes){
    if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return null;
    let i=2;while(i+4<=bytes.length){if(bytes[i++]!==255)return null;while(bytes[i]===255)i++;const marker=bytes[i++];if(marker===218||marker===217)return null;if(marker===1||(marker>=208&&marker<=215))continue;if(i+2>bytes.length)return null;const length=bytes.readUInt16BE(i);if(length<2||i+length>bytes.length)return null;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)return null;return {height:bytes.readUInt16BE(i+3),width:bytes.readUInt16BE(i+5)};}i+=length;}return null;
  }
  function handle(ws,raw,user){
    let input;try{if(Buffer.byteLength(raw)>96*1024){error(ws,'通话数据过大');return true;}input=JSON.parse(raw.toString());}catch{return false;}
    if(!input||typeof input.type!=='string'||!input.type.startsWith('call-'))return false;
    if(!user||user.id!==ws.userId||!valid(ws)){finish(calls.get(byUser.get(ws.userId)),'session-ended');return true;}
    const userId=user.id;
    if(input.type==='call-start'){
      if(typeof input.peerId!=='string'||input.peerId.length>80||input.peerId===userId||!['audio','video'].includes(input.mode)||typeof input.clientId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(input.clientId)){error(ws,'通话信息不完整',input);return true;}
      const existing=calls.get(byUser.get(userId));if(existing?.callerId===userId&&existing.clientId===input.clientId&&existing.calleeId===input.peerId&&existing.mode===input.mode&&existing.callerSocket===ws){emit(userId,{type:'call-state',call:view(existing)});return true;}
      if(!canCall(userId,input.peerId)||!publicUser(input.peerId)){error(ws,'暂时无法向对方发起通话',input);return true;}
      if(existing||byUser.has(input.peerId)){error(ws,'你或对方正在通话中',input);return true;}
      if(calls.size>=maxCalls){error(ws,'当前通话较多，请稍后重试',input);return true;}
      const minute=Math.floor(now()/60000),rate=starts.get(userId);if(rate?.minute===minute&&rate.count>=8){error(ws,'通话请求过多，请稍后重试',input);return true;}starts.set(userId,{minute,count:rate?.minute===minute?rate.count+1:1});
      const call={id:randomUUID(),clientId:input.clientId,callerId:userId,calleeId:input.peerId,mode:input.mode,state:'ringing',createdAt:new Date(now()).toISOString(),createdMs:now(),callerSocket:ws,calleeSocket:null,rates:new Map()};
      calls.set(call.id,call);byUser.set(userId,call.id);byUser.set(input.peerId,call.id);publish(call);return true;
    }
    const call=typeof input.callId==='string'?calls.get(input.callId):null;
    if(!call||![call.callerId,call.calleeId].includes(userId)){error(ws,'这个通话已结束或不可访问',input);return true;}
    if(!canCall(call.callerId,call.calleeId)||!valid(call.callerSocket)||(call.calleeSocket&&!valid(call.calleeSocket))){finish(call,'session-ended');return true;}
    if(input.type==='call-answer'){
      if(userId!==call.calleeId||call.state!=='ringing'||typeof input.accept!=='boolean'){error(ws,'不能操作这个通话',input);return true;}
      if(!input.accept){finish(call,'rejected');return true;}
      call.calleeSocket=ws;call.state='active';call.startedAt=new Date(now()).toISOString();publish(call);return true;
    }
    const bound=userId===call.callerId?call.callerSocket:call.calleeSocket;
    if(input.type==='call-end'){
      if(bound!==ws&&!(call.state==='ringing'&&userId===call.calleeId)){error(ws,'请在发起通话的设备上操作',input);return true;}
      finish(call,'hangup');return true;
    }
    if(input.type==='call-control'){
      if(call.state!=='active'||bound!==ws||typeof input.microphoneMuted!=='boolean'||typeof input.videoEnabled!=='boolean'){error(ws,'当前设备不在进行中的通话内',input);return true;}
      const key=userId+':control',window=Math.floor(now()/1000),last=call.rates.get(key);const count=last?.window===window?last.count+1:1;call.rates.set(key,{window,count});if(count>8)return true;
      const peer=userId===call.callerId?call.calleeSocket:call.callerSocket;if(valid(peer)&&peer.bufferedAmount<128*1024)peer.send(JSON.stringify({type:'call-control',callId:call.id,senderId:userId,microphoneMuted:input.microphoneMuted,videoEnabled:input.videoEnabled}));return true;
    }
    if(input.type!=='call-frame'){error(ws,'不支持的通话操作',input);return true;}
    if(call.state!=='active'||bound!==ws){error(ws,'当前设备不在进行中的通话内',input);return true;}
    if(!['audio','video'].includes(input.kind)||(input.kind==='video'&&call.mode!=='video')){error(ws,'不支持的通话数据',input);return true;}
    const bytes=decode(input.data,input.kind==='audio'?4096:40*1024);let dimensions;
    if(!bytes||(input.kind==='audio'&&(input.sampleRate!==16000||bytes.length<2||bytes.length%2))||(input.kind==='video'&&(!(dimensions=jpegDimensions(bytes))||dimensions.width>320||dimensions.height>240||dimensions.width<1||dimensions.height<1||input.width!==dimensions.width||input.height!==dimensions.height))){error(ws,'通话数据格式不正确',input);return true;}
    const window=Math.floor(now()/1000),key=userId+':'+input.kind;let rate=call.rates.get(key);if(!rate||rate.window!==window){rate={window,count:0,bytes:0};call.rates.set(key,rate);}rate.count++;rate.bytes+=bytes.length;if(rate.count>(input.kind==='audio'?50:8)||rate.bytes>(input.kind==='audio'?80*1024:256*1024))return true;
    const peer=userId===call.callerId?call.calleeSocket:call.callerSocket;if(!valid(peer)){finish(call,'session-ended');return true;}if(peer.bufferedAmount>128*1024)return true;
    try{peer.send(JSON.stringify({type:'call-frame',callId:call.id,senderId:userId,kind:input.kind,data:input.data,...(input.kind==='audio'?{sampleRate:16000}:dimensions)}));}catch{finish(call,'disconnected');}
    return true;
  }
  const timer=setInterval(()=>{for(const call of calls.values()){if(!valid(call.callerSocket)||(call.calleeSocket&&!valid(call.calleeSocket))||!canCall(call.callerId,call.calleeId))finish(call,'session-ended');else if(call.state==='ringing'&&now()-call.createdMs>ringMs)finish(call,'missed');else if(call.startedAt&&now()-Date.parse(call.startedAt)>30*60000)finish(call,'timeout');}for(const [id,rate]of starts)if(Math.floor(now()/60000)-rate.minute>2)starts.delete(id);},1000);timer.unref();
  return {handle,current(userId){const call=calls.get(byUser.get(userId));return call?view(call):null;},detach(ws){for(const call of calls.values())if(call.callerSocket===ws||call.calleeSocket===ws)finish(call,'disconnected');},close(){clearInterval(timer);for(const call of [...calls.values()])finish(call,'server-restart');},get size(){return calls.size;}};
}
