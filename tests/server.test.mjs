import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {randomUUID,createHash,scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WebSocket} from 'ws';
import http from 'node:http';

const temporary=mkdtempSync(join(tmpdir(),'ichat-server-test-'));
const password='TestPassword2026!';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=','base64');
const fixtures=[];
function fixture(name,extraEnv={}){
  const database=join(temporary,name+'.sqlite');let child,base,stderr='';const sockets=new Set();
  const result={database,get base(){return base;},get stderr(){return stderr;},async start(){
    child=spawn(process.execPath,[resolve('server/index.mjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DB_PATH:database,MEDIA_DIR:join(temporary,name+'-uploads'),ICHAT_DEMO:'0',...extraEnv},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(new Error('Server start timeout: '+stderr)),10000);child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>{const match=chunk.toString().match(/listening on (http:\/\/[^\s]+)/);if(match){base=match[1];clearTimeout(timer);accept();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Unexpected server exit ${code}: ${stderr}`));});});
  },async stop(){
    for(const socket of sockets)socket.terminate();sockets.clear();if(!child||child.exitCode!==null)return;
    await new Promise(accept=>{const timer=setTimeout(()=>{child.kill();accept();},4000);child.once('exit',()=>{clearTimeout(timer);accept();});child.send('shutdown');});
  },async call(route,{method='GET',token,body,bytes,headers={}}={}){
    const response=await fetch(base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:bytes??(body!==undefined?JSON.stringify(body):undefined)});
    const raw=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(raw);}catch{}return {status:response.status,data,raw,headers:response.headers};
  },async socket(token){
    const socket=new WebSocket(base.replace('http','ws')+'/ws',['ichat.v1',token]),events=[];sockets.add(socket);socket.on('message',bytes=>events.push(JSON.parse(bytes)));socket.on('close',()=>sockets.delete(socket));await new Promise((accept,reject)=>{socket.once('open',accept);socket.once('error',reject);});return {socket,events,async wait(predicate){const deadline=Date.now()+3000;while(Date.now()<deadline){const index=events.findIndex(predicate);if(index>=0)return events.splice(index,1)[0];await new Promise(accept=>setTimeout(accept,10));}throw new Error('Expected WebSocket event not received: '+JSON.stringify(events));},close(){socket.close();}};
  }};fixtures.push(result);return result;
}
const app=fixture('main');
const call=(...args)=>app.call(...args);
const post=(route,token,body)=>call(route,{method:'POST',token,body});
async function befriend(sender,receiver){const request=await post('/api/friend-requests',sender.token,{identifier:receiver.user.username});assert.equal(request.status,201,JSON.stringify(request.data));assert.equal((await post(`/api/friend-requests/${request.data.request.id}/respond`,receiver.token,{action:'accept'})).status,200);}
async function photo(owner,purpose='message',bytes=png,mime='image/png'){return call(`/api/media?purpose=${purpose}`,{method:'POST',token:owner.token,bytes,headers:{'Content-Type':mime}});}
async function send(owner,id,body,extra={}){return post(`/api/conversations/${id}/messages`,owner.token,{body,clientId:randomUUID(),...extra});}
async function heldPost(app,route,token,input,{bytes,mime='application/json'}={}){
  const payload=bytes??Buffer.from(JSON.stringify(input));let request,readyTimer;
  let readyAccept,readyReject;const ready=new Promise((accept,reject)=>{readyAccept=accept;readyReject=reject;});
  const response=new Promise((accept,reject)=>{request=http.request(app.base+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':mime,'Content-Length':payload.length,Expect:'100-continue'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{clearTimeout(readyTimer);let data;try{data=JSON.parse(Buffer.concat(chunks));}catch{}accept({status:res.statusCode,data});});});request.on('error',error=>{readyReject(error);reject(error);});});
  request.once('continue',()=>{clearTimeout(readyTimer);request.write(payload.subarray(0,1));readyAccept();});
  readyTimer=setTimeout(()=>readyReject(new Error('Held request did not reach the server')),2000);request.flushHeaders();await ready;
  return {async finish(){request.end(payload.subarray(1));return response;},abort(){request.destroy();}};
}
let alice,bob,outsider,carol,conversationId,messageId,messageSeq,groupId,privatePhoto,avatarId;
before(()=>app.start());
after(async()=>{for(const item of fixtures)await item.stop();const target=resolve(temporary);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('ichat-server-test-'));rmSync(target,{recursive:true,force:true});});

test('register supports unverified phone/password and legacy accounts, with collision-safe normalization',async()=>{
  const health=await call('/api/health');assert.equal(health.data.version,'1.2.0');assert.equal(health.data.demo,false);assert.ok(health.data.features.includes('groups'));
  assert.equal((await post('/api/register',null,{username:'x',displayName:'x',password:'short'})).status,400);
  async function register(username,displayName,phone){const result=await post('/api/register',null,{username,displayName,phone,password});assert.equal(result.status,201,JSON.stringify(result.data));assert.ok(result.data.token);assert.equal(result.data.user.password_hash,undefined);assert.equal(result.data.user.phoneVerified,false);return result.data;}
  alice=await register('alice_test','小林','+86 13800000001');bob=await register('bob_test','陈序','13900000002');outsider=await register('outsider_test','访客');carol=await register(undefined,'新朋友','+14155550123');
  assert.equal(alice.user.phone,'13800000001');assert.equal(outsider.user.phone,null);assert.match(carol.user.username,/^u_[a-f0-9]+$/);
  assert.equal((await post('/api/register',null,{username:'duplicate_phone',displayName:'重复',phone:'13800000001',password})).status,409);
  assert.equal((await post('/api/register',null,{username:'13800000001',displayName:'冲突',password})).status,409);
  assert.equal((await post('/api/register',null,{username:'12345678',displayName:'数字账号',password})).status,201);
  assert.equal((await post('/api/register',null,{phone:'12345678',displayName:'无效',password})).status,400);
  assert.equal((await post('/api/register',null,{username:'bad_phone',phone:'+8612345678901',displayName:'无效',password})).status,400);
  assert.equal((await post('/api/register',null,{displayName:'无账号',password})).status,400);
  assert.equal((await post('/api/login',null,{identifier:'13800000001',password:'wrongpass'})).status,401);
  for(const identifier of ['alice_test','13800000001','+8613800000001'])assert.equal((await post('/api/login',null,{identifier,password})).data.user.id,alice.user.id);
  assert.equal((await post('/api/login',null,{username:'bob_test',password})).status,200);
  assert.equal((await post('/api/login',null,{identifier:'+14155550123',password})).data.user.id,carol.user.id);
  assert.equal((await call('/api/contacts')).status,401);assert.equal((await post('/api/demo/login',null,{username:'lin'})).status,404);
});

test('contacts require accepted requests; exact account/phone search does not reveal phone numbers',async()=>{
  assert.deepEqual((await call('/api/contacts',{token:alice.token})).data.users,[]);
  assert.equal((await post('/api/conversations',alice.token,{userId:bob.user.id})).status,403);
  assert.deepEqual((await call('/api/users/search?q=bob',{token:alice.token})).data.users,[]);
  const found=await call('/api/users/search?q=%2B8613900000002',{token:alice.token});assert.equal(found.data.users[0].id,bob.user.id);assert.equal(found.data.users[0].phone,undefined);assert.equal(found.data.relationship,'none');
  assert.equal((await post('/api/friend-requests',alice.token,{identifier:'alice_test'})).status,400);
  const first=await post('/api/friend-requests',alice.token,{identifier:'13900000002',message:'我是小林'});assert.equal(first.status,201);assert.equal(first.data.request.user.id,bob.user.id);
  assert.equal((await post('/api/friend-requests',alice.token,{identifier:'bob_test'})).data.request.id,first.data.request.id);
  assert.equal((await call('/api/users/search?q=alice_test',{token:bob.token})).data.relationship,'incoming');
  const incoming=(await call('/api/friend-requests',{token:bob.token})).data.incoming;assert.equal(incoming[0].message,'我是小林');assert.equal(incoming[0].user.phone,undefined);
  assert.equal((await post(`/api/friend-requests/${first.data.request.id}/respond`,outsider.token,{action:'accept'})).status,403);
  const crossed=await post('/api/friend-requests',bob.token,{identifier:'alice_test'});assert.equal(crossed.status,409);assert.equal(crossed.data.requestId,first.data.request.id);
  assert.equal((await post(`/api/friend-requests/${first.data.request.id}/respond`,bob.token,{action:'reject'})).data.request.status,'rejected');
  await befriend(alice,bob);assert.deepEqual((await call('/api/contacts',{token:alice.token})).data.users.map(user=>user.id),[bob.user.id]);assert.equal((await call('/api/users/search?q=bob_test',{token:alice.token})).data.relationship,'friend');
  assert.equal((await call('/api/friend-requests',{token:bob.token})).data.incoming.length,0);assert.ok((await call('/api/friend-requests',{token:alice.token})).data.outgoing.some(row=>row.status==='accepted'));
});

test('friendships notify both users and direct conversations remain unique and private',async()=>{
  const live=await app.socket(alice.token);try{const request=await post('/api/friend-requests',carol.token,{identifier:'alice_test'});const notification=await live.wait(event=>event.type==='relationship');assert.equal(notification.type,'relationship');assert.equal((await post(`/api/friend-requests/${request.data.request.id}/respond`,alice.token,{action:'accept'})).status,200);}finally{live.close();}
  const first=await post('/api/conversations',alice.token,{userId:bob.user.id});assert.equal(first.status,200);conversationId=first.data.conversation.id;assert.equal(first.data.conversation.kind,'direct');assert.equal(first.data.conversation.memberCount,2);
  assert.equal((await post('/api/conversations',bob.token,{userId:alice.user.id})).data.conversation.id,conversationId);
  assert.equal((await call(`/api/conversations/${conversationId}/messages`,{token:outsider.token})).status,403);assert.equal((await send(outsider,conversationId,'unauthorized')).status,403);
});

test('WebSocket text delivery, sender profile and durable history use compatible message fields',async()=>{
  const live=await app.socket(bob.token);try{const sent=await send(alice,conversationId,'这是一条真实的实时消息。');assert.equal(sent.status,201);messageId=sent.data.message.id;messageSeq=sent.data.message.seq;const event=await live.wait(event=>event.type==='message');assert.equal(event.message.id,messageId);assert.equal(event.message.kind,'text');assert.equal(event.message.sender.id,alice.user.id);assert.equal(event.message.sender.phone,undefined);assert.equal(event.conversation.kind,'direct');assert.equal((await call(`/api/conversations/${conversationId}/messages`,{token:bob.token})).data.messages[0].body,'这是一条真实的实时消息。');}finally{live.close();}
});

test('message retries are idempotent and client IDs cannot be reused for other contents or kinds',async()=>{
  const clientId=randomUUID(),payload={body:'<img src=x onerror=alert(1)>',clientId};const first=await post(`/api/conversations/${conversationId}/messages`,alice.token,payload),second=await post(`/api/conversations/${conversationId}/messages`,alice.token,payload);assert.equal(first.status,201);assert.equal(second.status,200);assert.equal(first.data.message.id,second.data.message.id);
  assert.equal((await post(`/api/conversations/${conversationId}/messages`,alice.token,{...payload,body:'changed'})).status,409);
  assert.equal((await post(`/api/conversations/${conversationId}/messages`,alice.token,{kind:'image',mediaId:randomUUID(),clientId})).status,409);
  assert.equal((await call(`/api/conversations/${conversationId}/messages`,{token:bob.token})).data.messages.filter(item=>item.clientId===clientId).length,1);
  const list=await call('/api/conversations',{token:bob.token});assert.equal(list.data.conversations[0].unread,2);await post(`/api/conversations/${conversationId}/read`,bob.token,{});assert.equal((await call('/api/conversations',{token:bob.token})).data.conversations[0].unread,0);
  assert.equal((await call(`/api/conversations/${conversationId}/messages?before=${messageSeq}`,{token:alice.token})).data.messages.length,0);assert.equal((await call(`/api/conversations/${conversationId}/messages?before=NaN`,{token:alice.token})).status,400);
});

test('photo uploads validate content, size and ownership; image messages remain private and idempotent',async()=>{
  assert.equal((await photo(alice,'message',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'image/svg+xml')).status,415);
  assert.equal((await photo(alice,'message',Buffer.from('not an image'))).status,400);assert.equal((await photo(alice,'message',png,'image/jpeg')).status,400);assert.equal((await photo(alice,'message',png.subarray(0,25))).status,400);
  assert.equal((await photo(alice,'message',Buffer.alloc(3*1024*1024+1))).status,413);
  const uploaded=await photo(alice);assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));privatePhoto=uploaded.data.media.id;assert.equal(uploaded.data.media.mime,'image/png');assert.equal(uploaded.data.media.filename,undefined);
  assert.equal((await call(`/api/media/${privatePhoto}`)).status,401);assert.equal((await call(`/api/media/${privatePhoto}`,{token:bob.token})).status,403);assert.equal((await call(`/api/media/${privatePhoto}`,{token:outsider.token})).status,403);
  assert.equal((await post(`/api/conversations/${conversationId}/messages`,bob.token,{kind:'image',mediaId:privatePhoto,clientId:randomUUID()})).status,403);
  const clientId=randomUUID(),sent=await post(`/api/conversations/${conversationId}/messages`,alice.token,{kind:'image',mediaId:privatePhoto,clientId});assert.equal(sent.status,201);assert.equal(sent.data.message.body,'[图片]');assert.equal(sent.data.message.mediaId,privatePhoto);
  assert.equal((await post(`/api/conversations/${conversationId}/messages`,alice.token,{kind:'image',mediaId:privatePhoto,clientId})).data.message.id,sent.data.message.id);
  const read=await call(`/api/media/${privatePhoto}`,{token:bob.token});assert.equal(read.status,200);assert.deepEqual(read.raw,png);assert.equal(read.headers.get('x-content-type-options'),'nosniff');assert.match(read.headers.get('cache-control'),/private/);assert.equal((await call(`/api/media/${privatePhoto}?token=${bob.token}`)).status,401);
  assert.equal((await call(`/api/media/${privatePhoto}`,{token:outsider.token})).status,403);
});

test('profile editing, owned avatars and password-checked phone changes preserve privacy',async()=>{
  const uploaded=await photo(alice,'avatar');assert.equal(uploaded.status,201);avatarId=uploaded.data.media.id;
  assert.equal((await post('/api/me',bob.token,{avatarId})).status,400);assert.equal((await post('/api/me',alice.token,{avatarId:privatePhoto})).status,400);
  const live=await app.socket(bob.token);try{const update=await post('/api/me',alice.token,{displayName:'林同学',username:'alice_new',about:'让对话自然发生',avatarId});assert.equal(update.status,200);alice.user=update.data.user;assert.equal(alice.user.phone,'13800000001');const event=await live.wait(event=>event.type==='profile');assert.equal(event.user.username,'alice_new');assert.equal(event.user.phone,undefined);}finally{live.close();}
  assert.equal((await call(`/api/media/${avatarId}`,{token:outsider.token})).status,200);
  assert.equal((await post('/api/me',alice.token,{phone:'13700000003'})).status,400);assert.equal((await post('/api/me',alice.token,{phone:'13700000003',currentPassword:'wrong'})).status,400);assert.equal((await call('/api/me',{token:alice.token})).status,200);
  assert.equal((await post('/api/me',alice.token,{phone:'13900000002',currentPassword:password})).status,409);
  const change=await post('/api/me',alice.token,{phone:'13700000003',currentPassword:password});assert.equal(change.status,200);alice.user=change.data.user;
  assert.equal((await post('/api/login',null,{identifier:'13800000001',password})).status,401);assert.equal((await post('/api/login',null,{identifier:'13700000003',password})).data.user.id,alice.user.id);
  assert.equal((await post('/api/me',alice.token,{about:'x'.repeat(161)})).status,400);assert.equal((await post('/api/me',alice.token,{username:'bob_test'})).status,409);
});

test('groups enforce invitation/owner rules and new members cannot read pre-join texts or photos',async()=>{
  assert.equal((await post('/api/groups',alice.token,{name:'违规群',userIds:[outsider.user.id]})).status,403);
  const group=await post('/api/groups',alice.token,{name:'项目讨论',userIds:[bob.user.id,bob.user.id]});assert.equal(group.status,201);groupId=group.data.conversation.id;assert.equal(group.data.conversation.kind,'group');assert.equal(group.data.conversation.memberCount,2);assert.equal(group.data.conversation.ownerId,alice.user.id);assert.equal(group.data.conversation.partner.displayName,'项目讨论');
  assert.equal((await call(`/api/groups/${groupId}`,{token:outsider.token})).status,403);assert.equal((await post(`/api/groups/${groupId}`,bob.token,{name:'篡改'})).status,403);
  const secret=await send(alice,groupId,'只给最初成员');const photoUploaded=await photo(alice);const groupPhoto=photoUploaded.data.media.id;await post(`/api/conversations/${groupId}/messages`,alice.token,{kind:'image',mediaId:groupPhoto,clientId:randomUUID()});
  assert.equal((await call(`/api/media/${groupPhoto}`,{token:carol.token})).status,403);
  const live=await app.socket(carol.token);try{assert.equal((await post(`/api/groups/${groupId}/members`,alice.token,{userIds:[carol.user.id]})).status,200);const update=await live.wait(event=>event.type==='conversation');assert.equal(update.conversation.id,groupId);assert.equal(update.conversation.memberCount,3);}finally{live.close();}
  const history=await call(`/api/conversations/${groupId}/messages`,{token:carol.token});assert.equal(history.data.messages.length,1);assert.equal(history.data.messages[0].kind,'system');assert.ok(!history.data.messages.some(message=>message.id===secret.data.message.id));assert.equal((await call(`/api/conversations/${groupId}/messages?before=${secret.data.message.seq+1}`,{token:carol.token})).data.messages.length,0);assert.equal((await call(`/api/media/${groupPhoto}`,{token:carol.token})).status,403);
  const carolList=(await call('/api/conversations',{token:carol.token})).data.conversations.find(item=>item.id===groupId);assert.equal(carolList.unread,1);
  assert.equal((await post(`/api/groups/${groupId}/members`,bob.token,{userIds:[outsider.user.id]})).status,403);
  const members=(await call(`/api/groups/${groupId}`,{token:bob.token})).data.members;assert.equal(members.length,3);assert.equal(members.find(member=>member.id===alice.user.id).role,'owner');assert.ok(members.every(member=>member.phone===undefined));
  assert.equal((await send(carol,groupId,'加入之后可以说话')).status,201);
});

test('group avatars are protected, owner removal revokes access, and rejoining does not restore old history',async()=>{
  const avatar=await photo(bob,'avatar');assert.equal((await post(`/api/groups/${groupId}`,alice.token,{avatarId:avatar.data.media.id})).status,400);const ownAvatar=await photo(alice,'avatar');assert.equal((await post(`/api/groups/${groupId}`,alice.token,{name:'新群名称',avatarId:ownAvatar.data.media.id})).status,200);
  assert.equal((await call(`/api/media/${ownAvatar.data.media.id}`,{token:bob.token})).status,200);assert.equal((await call(`/api/media/${ownAvatar.data.media.id}`,{token:outsider.token})).status,403);
  assert.equal((await post(`/api/groups/${groupId}/remove`,bob.token,{userId:carol.user.id})).status,403);
  const live=await app.socket(carol.token);try{assert.equal((await post(`/api/groups/${groupId}/remove`,alice.token,{userId:carol.user.id})).status,200);assert.equal((await live.wait(event=>event.type==='conversation-removed')).conversationId,groupId);}finally{live.close();}
  assert.equal((await call(`/api/conversations/${groupId}/messages`,{token:carol.token})).status,403);assert.equal((await send(carol,groupId,'已被移出')).status,403);assert.equal((await call(`/api/media/${ownAvatar.data.media.id}`,{token:carol.token})).status,403);
  assert.equal((await post(`/api/groups/${groupId}/members`,alice.token,{userIds:[carol.user.id]})).status,200);const rejoined=(await call(`/api/conversations/${groupId}/messages`,{token:carol.token})).data.messages;assert.equal(rejoined.length,1);assert.equal(rejoined[0].kind,'system');
  assert.equal((await post(`/api/groups/${groupId}/leave`,alice.token,{})).status,200);const after=(await call(`/api/groups/${groupId}`,{token:bob.token})).data;assert.equal(after.conversation.ownerId,bob.user.id);assert.equal(after.members.find(member=>member.id===bob.user.id).role,'owner');assert.equal((await call(`/api/groups/${groupId}`,{token:alice.token})).status,403);
});

test('presence only lists friends/shared-group members and password change revokes other sessions',async()=>{
  const a=await app.socket(alice.token),unrelated=await app.socket(outsider.token);try{const initial=await unrelated.wait(event=>event.type==='presence');assert.ok(!initial.userIds.includes(alice.user.id));assert.ok(initial.userIds.includes(outsider.user.id));}finally{a.close();unrelated.close();}
  const other=(await post('/api/login',null,{identifier:'alice_new',password})).data;assert.equal((await post('/api/password',alice.token,{currentPassword:'wrong',newPassword:'ChangedPassword2026!'})).status,400);assert.equal((await call('/api/me',{token:alice.token})).status,200);assert.equal((await call('/api/me',{token:other.token})).status,200);
  const live=await app.socket(other.token);const closed=new Promise(accept=>live.socket.once('close',accept));assert.equal((await post('/api/password',alice.token,{currentPassword:password,newPassword:'ChangedPassword2026!'})).status,200);await closed;
  assert.equal((await call('/api/me',{token:other.token})).status,401);assert.equal((await call('/api/me',{token:alice.token})).status,200);assert.equal((await post('/api/login',null,{identifier:'alice_new',password})).status,401);assert.equal((await post('/api/login',null,{identifier:'alice_new',password:'ChangedPassword2026!'})).status,200);
});

test('restart preserves users, messages, sessions and uploaded image bytes; logout revokes the token',async()=>{
  await app.stop();await app.start();const history=await call(`/api/conversations/${conversationId}/messages`,{token:bob.token});assert.equal(history.status,200);assert.ok(history.data.messages.some(message=>message.id===messageId));assert.deepEqual((await call(`/api/media/${privatePhoto}`,{token:bob.token})).raw,png);assert.equal((await call('/api/me',{token:alice.token})).data.user.username,'alice_new');
  assert.equal((await post('/api/logout',alice.token,{})).status,200);assert.equal((await call('/api/me',{token:alice.token})).status,401);assert.equal((await call(`/api/media/${privatePhoto}`,{token:alice.token})).status,401);
});

test('legacy schema migrates atomically once, retaining old sessions, pagination and explicit friendship removals',async()=>{
  const legacy=fixture('legacy');const database=new DatabaseSync(legacy.database),salt='legacy-salt',hash=scryptSync(password,salt,64).toString('hex'),oldToken='legacy-valid-token',expiredToken='legacy-expired-token';
  database.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);CREATE TABLE conversations(id TEXT PRIMARY KEY,direct_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);CREATE TABLE members(conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),read_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversation_id,user_id));CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),sender_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(sender_id,client_id));`);
  for(const id of ['legacy-a','legacy-b'])database.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,id.replace('-','_'),id,hash,salt,'2026-10-01T00:00:00.000Z');database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(oldToken).digest('hex'),'legacy-a',Date.now()+86400000);database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(expiredToken).digest('hex'),'legacy-a',Date.now()-1);database.prepare('INSERT INTO conversations VALUES(?,?,?)').run('legacy-conversation','legacy-a:legacy-b','2026-10-01T00:00:00.000Z');for(const id of ['legacy-a','legacy-b'])database.prepare('INSERT INTO members(conversation_id,user_id) VALUES(?,?)').run('legacy-conversation',id);for(let index=0;index<52;index++)database.prepare('INSERT INTO messages(id,conversation_id,sender_id,client_id,body,created_at) VALUES(?,?,?,?,?,?)').run('legacy-message-'+index,'legacy-conversation','legacy-b','legacy-client-'+index,'legacy '+index,'2026-10-01T00:00:00.000Z');database.close();
  await legacy.start();assert.equal((await legacy.call('/api/me',{token:oldToken})).data.user.phone,null);assert.equal((await legacy.call('/api/me',{token:expiredToken})).status,401);assert.equal((await legacy.call('/api/contacts',{token:oldToken})).data.users[0].id,'legacy-b');const first=(await legacy.call('/api/conversations/legacy-conversation/messages',{token:oldToken})).data;assert.equal(first.messages.length,50);assert.equal(first.hasMore,true);assert.equal(first.messages[0].body,'legacy 2');const next=(await legacy.call('/api/conversations/legacy-conversation/messages?before='+first.messages[0].seq,{token:oldToken})).data;assert.equal(next.messages.length,2);assert.equal(next.hasMore,false);
  const sent=await legacy.call('/api/conversations/legacy-conversation/messages',{method:'POST',token:oldToken,body:{body:'new with old session',clientId:randomUUID()}});assert.equal(sent.status,201);assert.equal((await legacy.call('/api/friends/legacy-b/remove',{method:'POST',token:oldToken,body:{}})).status,200);assert.equal((await legacy.call('/api/conversations/legacy-conversation/messages',{method:'POST',token:oldToken,body:{body:'blocked',clientId:randomUUID()}})).status,403);
  await legacy.stop();await legacy.start();assert.deepEqual((await legacy.call('/api/contacts',{token:oldToken})).data.users,[]);assert.equal((await legacy.call('/api/conversations/legacy-conversation/messages',{token:oldToken})).status,200);assert.equal((await legacy.call('/api/conversations',{method:'POST',token:oldToken,body:{userId:'legacy-b'}})).status,403);await legacy.stop();
});

test('image admission bounds concurrent uploads and rejects malformed dimensions and containers',async()=>{
  const bounded=fixture('bounded');await bounded.start();const owner=(await bounded.call('/api/register',{method:'POST',body:{username:'bounded_user',displayName:'上传测试',password}})).data;
  const oversized=Buffer.from(png);oversized.writeUInt32BE(10001,16);
  const malformedWebp=Buffer.from('5249464612000000574542505650384cffffffff2f00000000','hex');
  for(const [bytes,mime]of [[oversized,'image/png'],[malformedWebp,'image/webp'],[Buffer.from([255,216,255,224,0,2,255,255,255,255,255,217]),'image/jpeg']])assert.equal((await bounded.call('/api/media?purpose=message',{method:'POST',token:owner.token,bytes,headers:{'Content-Type':mime}})).status,400);
  const pending=[];
  try{
    for(let index=0;index<3;index++){
      let request;const response=new Promise((accept,reject)=>{request=http.request(bounded.base+'/api/media?purpose=message',{method:'POST',headers:{Authorization:'Bearer '+owner.token,'Content-Type':'image/png','Content-Length':png.length}},res=>{res.resume();res.once('end',()=>accept(res.statusCode));});request.on('error',reject);});request.write(png.subarray(0,16));pending.push({request,response});
    }
    await new Promise(accept=>setTimeout(accept,80));assert.equal((await bounded.call('/api/media?purpose=message',{method:'POST',token:owner.token,bytes:png,headers:{'Content-Type':'image/png'}})).status,429);
    for(const item of pending)item.request.end(png.subarray(16));assert.deepEqual(await Promise.all(pending.map(item=>item.response)),[201,201,201]);
    assert.equal((await bounded.call('/api/media?purpose=message',{method:'POST',token:owner.token,bytes:png,headers:{'Content-Type':'image/png'}})).status,201);
  }finally{for(const item of pending)item.request.destroy();await bounded.stop();}
});

test('proxy rate limiting accepts X-Real-IP only with explicit loopback trust and ignores invalid values',async()=>{
  const trusted=fixture('trusted-proxy',{TRUST_PROXY:'loopback'});await trusted.start();
  for(let index=0;index<26;index++)assert.equal((await trusted.call('/api/login',{method:'POST',body:{identifier:'missing_user',password:'bad'},headers:{'X-Real-IP':'203.0.113.11'}})).status,index===25?429:401);
  assert.equal((await trusted.call('/api/login',{method:'POST',body:{identifier:'missing_user',password:'bad'},headers:{'X-Real-IP':'203.0.113.12'}})).status,401);
  for(let index=0;index<26;index++)assert.equal((await trusted.call('/api/login',{method:'POST',body:{identifier:'missing_user',password:'bad'},headers:{'X-Real-IP':'invalid-'+index}})).status,index===25?429:401);
  await trusted.stop();
  const untrusted=fixture('untrusted-proxy');await untrusted.start();for(let index=0;index<26;index++)assert.equal((await untrusted.call('/api/login',{method:'POST',body:{identifier:'missing_user',password:'bad'},headers:{'X-Real-IP':'203.0.113.'+(index+1)}})).status,index===25?429:401);await untrusted.stop();
});

test('expired WebSocket sessions stop receiving messages immediately, before the heartbeat',async()=>{
  const expired=fixture('expired-socket');await expired.start();const register=async username=>(await expired.call('/api/register',{method:'POST',body:{username,displayName:username,password}})).data;const sender=await register('expiry_sender'),receiver=await register('expiry_receiver');
  const request=(await expired.call('/api/friend-requests',{method:'POST',token:sender.token,body:{identifier:receiver.user.username}})).data.request;await expired.call(`/api/friend-requests/${request.id}/respond`,{method:'POST',token:receiver.token,body:{action:'accept'}});const conversation=(await expired.call('/api/conversations',{method:'POST',token:sender.token,body:{userId:receiver.user.id}})).data.conversation;
  const live=await expired.socket(receiver.token),closed=new Promise(accept=>live.socket.once('close',accept));const database=new DatabaseSync(expired.database);database.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now()-1,createHash('sha256').update(receiver.token).digest('hex'));database.close();
  assert.equal((await expired.call(`/api/conversations/${conversation.id}/messages`,{method:'POST',token:sender.token,body:{body:'private after expiry',clientId:randomUUID()}})).status,201);await closed;assert.ok(!live.events.some(event=>event.type==='message'));assert.equal((await expired.call('/api/me',{token:receiver.token})).status,401);await expired.stop();
});

test('held group requests recheck membership and ownership after another request removes or replaces the caller',async()=>{
  const racing=fixture('group-body-race');await racing.start();const localPost=(route,user,body)=>racing.call(route,{method:'POST',token:user.token,body});const register=async username=>(await localPost('/api/register',{}, {username,displayName:username,password})).data;const owner=await register('race_owner'),member=await register('race_member'),invitee=await register('race_invitee');
  const friends=async(a,b)=>{const request=(await localPost('/api/friend-requests',a,{identifier:b.user.username})).data.request;assert.equal((await localPost(`/api/friend-requests/${request.id}/respond`,b,{action:'accept'})).status,200);};await friends(owner,member);await friends(member,invitee);
  const group=(await localPost('/api/groups',owner,{name:'权限变更测试',userIds:[member.user.id]})).data.conversation;
  const clientId=randomUUID(),held=[await heldPost(racing,`/api/conversations/${group.id}/messages`,member.token,{body:'removed caller must not send',clientId}),await heldPost(racing,`/api/groups/${group.id}/members`,member.token,{userIds:[invitee.user.id]}),await heldPost(racing,`/api/conversations/${group.id}/read`,member.token,{}),await heldPost(racing,`/api/groups/${group.id}/leave`,member.token,{})];
  assert.equal((await localPost(`/api/groups/${group.id}/remove`,owner,{userId:member.user.id})).status,200);assert.deepEqual((await Promise.all(held.map(item=>item.finish()))).map(result=>result.status),[403,403,403,403]);
  const remaining=(await racing.call(`/api/groups/${group.id}`,{token:owner.token})).data;assert.deepEqual(remaining.members.map(user=>user.id),[owner.user.id]);assert.ok(!(await racing.call(`/api/conversations/${group.id}/messages`,{token:owner.token})).data.messages.some(message=>message.clientId===clientId));
  const transferred=(await localPost('/api/groups',owner,{name:'原群名',userIds:[member.user.id]})).data.conversation;
  const edit=await heldPost(racing,`/api/groups/${transferred.id}`,owner.token,{name:'过期权限改名'}),remove=await heldPost(racing,`/api/groups/${transferred.id}/remove`,owner.token,{userId:member.user.id});
  assert.equal((await localPost(`/api/groups/${transferred.id}/leave`,owner,{})).status,200);assert.equal((await localPost(`/api/groups/${transferred.id}/members`,member,{userIds:[owner.user.id]})).status,200);
  assert.equal((await edit.finish()).status,403);assert.equal((await remove.finish()).status,403);const current=(await racing.call(`/api/groups/${transferred.id}`,{token:owner.token})).data;assert.equal(current.conversation.title,'原群名');assert.equal(current.conversation.ownerId,member.user.id);assert.equal(current.members.length,2);await racing.stop();
});

test('held protected mutations and photo uploads fail after logout, without writes from a revoked session',async()=>{
  const racing=fixture('session-body-race');await racing.start();const localPost=(route,user,body)=>racing.call(route,{method:'POST',token:user?.token,body});const register=async username=>(await localPost('/api/register',null,{username,displayName:username,password})).data;const owner=await register('session_owner'),friend=await register('session_friend'),applicant=await register('session_applicant');
  const friendship=(await localPost('/api/friend-requests',owner,{identifier:friend.user.username})).data.request;await localPost(`/api/friend-requests/${friendship.id}/respond`,friend,{action:'accept'});const incoming=(await localPost('/api/friend-requests',applicant,{identifier:owner.user.username})).data.request;const direct=(await localPost('/api/conversations',owner,{userId:friend.user.id})).data.conversation,group=(await localPost('/api/groups',owner,{name:'会话保留',userIds:[friend.user.id]})).data.conversation;
  const cases=[['/api/me',{displayName:'must not persist',phone:'13600000009',currentPassword:password}],['/api/password',{currentPassword:password,newPassword:'MustNotReplace2026!'}],['/api/friend-requests',{identifier:applicant.user.username}],[`/api/friend-requests/${incoming.id}/respond`,{action:'accept'}],['/api/conversations',{userId:friend.user.id}],['/api/groups',{name:'must not create',userIds:[friend.user.id]}],[`/api/groups/${group.id}`,{name:'must not rename'}],[`/api/groups/${group.id}/members`,{userIds:[applicant.user.id]}],[`/api/groups/${group.id}/remove`,{userId:friend.user.id}],[`/api/groups/${group.id}/leave`,{}],[`/api/conversations/${direct.id}/messages`,{body:'must not send',clientId:randomUUID()}],[`/api/conversations/${direct.id}/read`,{}]];
  const held=[];for(const [route,input]of cases)held.push(await heldPost(racing,route,owner.token,input));held.push(await heldPost(racing,'/api/media?purpose=message',owner.token,null,{bytes:png,mime:'image/png'}));
  assert.equal((await localPost('/api/logout',owner,{})).status,200);assert.deepEqual((await Promise.all(held.map(item=>item.finish()))).map(result=>result.status),Array(held.length).fill(401));
  const fresh=(await localPost('/api/login',null,{identifier:owner.user.username,password})).data;assert.ok(fresh.token);const me=(await racing.call('/api/me',{token:fresh.token})).data.user;assert.equal(me.displayName,'session_owner');assert.equal(me.phone,null);const current=(await racing.call(`/api/groups/${group.id}`,{token:fresh.token})).data;assert.equal(current.conversation.title,'会话保留');assert.equal(current.members.length,2);assert.equal((await racing.call('/api/friend-requests',{token:fresh.token})).data.incoming[0].id,incoming.id);
  await racing.stop();const database=new DatabaseSync(racing.database);assert.equal(database.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal(database.prepare("SELECT count(*) AS n FROM messages WHERE body='must not send'").get().n,0);assert.equal(database.prepare("SELECT count(*) AS n FROM conversations WHERE title='must not create'").get().n,0);database.close();
});

test('held profile updates use fresh account fields rather than overwriting another completed edit',async()=>{
  const racing=fixture('profile-body-race');await racing.start();const owner=(await racing.call('/api/register',{method:'POST',body:{username:'fresh_profile',displayName:'Original',password}})).data;
  const held=await heldPost(racing,'/api/me',owner.token,{displayName:'New name'});assert.equal((await racing.call('/api/me',{method:'POST',token:owner.token,body:{about:'Keep this fresh signature',phone:'13600000009',currentPassword:password}})).status,200);const finished=await held.finish();assert.equal(finished.status,200);assert.equal(finished.data.user.displayName,'New name');assert.equal(finished.data.user.about,'Keep this fresh signature');assert.equal(finished.data.user.phone,'13600000009');await racing.stop();
});
