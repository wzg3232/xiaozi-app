import test from 'node:test';
import assert from 'node:assert/strict';
import {createCallHub} from '../server/calls.mjs';
function fixture(options={}){
 const events=[],summaries=[],users=new Map(['a','b','c'].map(id=>[id,{id,username:id,displayName:id}]));let allowed=true,time=100000;
 const hub=createCallHub({publicUser:id=>users.get(id),canCall:(a,b)=>allowed&&a!==b&&users.has(a)&&users.has(b),notify:(id,event)=>events.push({id,...event}),isSocketValid:ws=>ws.valid!==false,onEnded:info=>summaries.push(info),now:()=>time,...options});
 const socket=id=>({userId:id,readyState:1,bufferedAmount:0,received:[],send(text){this.received.push(JSON.parse(text));}});const a=socket('a'),b=socket('b'),c=socket('c');
 const send=(ws,data)=>hub.handle(ws,Buffer.from(JSON.stringify(data)),users.get(ws.userId));
 const start=(mode='audio')=>{send(a,{type:'call-start',peerId:'b',mode,clientId:'call_client_id_12345'});return hub.current('a');};
 return {hub,events,summaries,send,start,a,b,c,socket,setAllowed:v=>allowed=v,setTime:v=>time=v};
}
test('calls require eligible friends, isolate participants and bind only the answering device',t=>{
 const f=fixture();t.after(()=>f.hub.close());f.setAllowed(false);f.start();assert.equal(f.hub.size,0);f.setAllowed(true);const call=f.start();assert.equal(f.hub.size,1);f.start();assert.equal(f.hub.size,1);
 f.send(f.c,{type:'call-answer',callId:call.id,accept:true});assert.equal(f.hub.current('a').state,'ringing');f.send(f.b,{type:'call-answer',callId:call.id,accept:true});assert.equal(f.hub.current('a').state,'active');
 const other=f.socket('a');f.send(other,{type:'call-frame',callId:call.id,kind:'audio',sampleRate:16000,data:Buffer.alloc(1280).toString('base64')});assert.equal(f.b.received.length,0);
 f.send(f.a,{type:'call-frame',callId:call.id,kind:'audio',sampleRate:16000,data:Buffer.alloc(1280).toString('base64'),senderId:'c'});assert.equal(f.b.received[0].senderId,'a');assert.equal(f.c.received.length,1); // its own authorization error only
});
test('calls validate media, rate/queue bounds and revoked receiver sessions on each frame',t=>{
 const f=fixture();t.after(()=>f.hub.close());const call=f.start();f.send(f.b,{type:'call-answer',callId:call.id,accept:true});const packet={type:'call-frame',callId:call.id,kind:'audio',sampleRate:16000,data:Buffer.alloc(1280).toString('base64')};
 f.send(f.a,{...packet,sampleRate:48000});assert.equal(f.b.received.length,0);f.b.bufferedAmount=200000;f.send(f.a,packet);assert.equal(f.b.received.length,0);f.b.bufferedAmount=0;for(let i=0;i<100;i++)f.send(f.a,packet);assert.ok(f.b.received.length<=50);
 f.b.valid=false;f.send(f.a,packet);assert.equal(f.hub.size,0);assert.equal(f.summaries[0].reason,'session-ended');
});
test('hangup/reject/disconnect preserve summaries without recordings and release both users',t=>{
 const f=fixture();t.after(()=>f.hub.close());let call=f.start();f.send(f.b,{type:'call-answer',callId:call.id,accept:false});assert.equal(f.hub.current('a'),null);assert.equal(f.summaries[0].reason,'rejected');
 call=f.start();f.send(f.b,{type:'call-answer',callId:call.id,accept:true});f.setTime(105000);f.hub.detach(f.a);assert.equal(f.hub.size,0);assert.equal(f.summaries[1].durationMs,5000);assert.equal(f.summaries[1].data,undefined);
});
