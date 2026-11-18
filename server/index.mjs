import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,existsSync,statSync,statfsSync,writeFileSync,openSync,closeSync,unlinkSync,createReadStream} from 'node:fs';
import {resolve,dirname,extname,sep} from 'node:path';
import {isIP} from 'node:net';
import {WebSocketServer,WebSocket} from 'ws';
import {migrateV12,createFeatures} from './features.mjs';
import {createCallHub} from './calls.mjs';
import {migrateEnterprise,createEnterprise} from './enterprise.mjs';
import {migrateWorkflows,createWorkflows} from './workflows.mjs';
import {createDemoEnterprise} from './demo-enterprise.mjs';

const root=resolve(import.meta.dirname,'..');
const port=Number(process.env.PORT||4200),host=process.env.HOST||'127.0.0.1';
const demo=process.argv.includes('--demo')||process.env.ICHAT_DEMO==='1';
const dbPath=resolve(process.env.DB_PATH||resolve(root,'data/ichat.sqlite'));
const mediaDir=resolve(process.env.MEDIA_DIR||resolve(dirname(dbPath),'uploads'));
mkdirSync(dirname(dbPath),{recursive:true});mkdirSync(mediaDir,{recursive:true,mode:0o700});
const db=new DatabaseSync(dbPath);
let features;
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
// Add columns rather than replacing tables: every existing account, token and message survives.
transaction(()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,direct_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members(conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),read_seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(conversation_id,user_id));
  CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),sender_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(sender_id,client_id));
  CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);`);
  const add=(table,column,definition)=>{if(!db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);};
  for(const [column,definition]of [['phone','TEXT'],['about',"TEXT NOT NULL DEFAULT ''"],['avatar_id','TEXT']])add('users',column,definition);
  for(const [column,definition]of [['kind',"TEXT NOT NULL DEFAULT 'direct'"],['title',"TEXT NOT NULL DEFAULT ''"],['avatar_id','TEXT'],['owner_id','TEXT REFERENCES users(id)']])add('conversations',column,definition);
  add('members','role',"TEXT NOT NULL DEFAULT 'member'");add('members','history_from_seq','INTEGER NOT NULL DEFAULT 0');
  add('messages','kind',"TEXT NOT NULL DEFAULT 'text'");add('messages','media_id','TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS user_phone ON users(phone) WHERE phone IS NOT NULL;
  CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,seq);
  CREATE INDEX IF NOT EXISTS member_user ON members(user_id,conversation_id);
  CREATE TABLE IF NOT EXISTS friendships(user_a TEXT NOT NULL REFERENCES users(id),user_b TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(user_a,user_b),CHECK(user_a<user_b));
  CREATE TABLE IF NOT EXISTS friend_requests(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES users(id),receiver_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,responded_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS pending_friend_request ON friend_requests(sender_id,receiver_id) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS request_receiver ON friend_requests(receiver_id,status,created_at);
  CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,filename TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS media_owner ON media(owner_id,created_at);
  CREATE INDEX IF NOT EXISTS message_media ON messages(media_id);`);
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('v1.1.0-legacy-friendships')){
    db.exec(`INSERT OR IGNORE INTO friendships(user_a,user_b,created_at)
    SELECT a.user_id,b.user_id,c.created_at FROM members a JOIN members b ON a.conversation_id=b.conversation_id AND a.user_id<b.user_id JOIN conversations c ON c.id=a.conversation_id WHERE c.kind='direct';`);
    db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)').run('v1.1.0-legacy-friendships',new Date().toISOString());
  }
});
migrateV12(db,transaction);
migrateEnterprise(db,transaction);
migrateWorkflows(db,transaction);
const publicUser=user=>({id:user.id,username:user.username,displayName:user.display_name,about:user.about||'',avatarId:user.avatar_id||null});
const selfUser=user=>({...publicUser(user),phone:user.phone||null,phoneVerified:false});
const getUser=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
const hashToken=token=>createHash('sha256').update(token).digest('hex');
const nowISO=()=>new Date().toISOString();
function fail(status,message){return Object.assign(new Error(message),{status});}
function string(value){return typeof value==='string'?value:'';}
function normalizePhone(input){if(input!==undefined&&input!==null&&typeof input!=='string')throw fail(400,'手机号格式不正确');const value=string(input).trim().replace(/[\s()-]/g,'');if(!value)return null;if(/^(?:\+86)?1[3-9]\d{9}$/.test(value))return value.replace(/^\+86/,'');if(/^\+[1-9]\d{7,14}$/.test(value)&&!value.startsWith('+86'))return value;throw fail(400,'请输入 11 位手机号，国际号码请以 +国家区号开头');}
function validatePassword(password){if(typeof password!=='string'||password.length<8||password.length>128)throw fail(400,'密码需为 8–128 位');return password;}
function validateUsername(input){const value=string(input).trim().toLowerCase();if(!/^[a-z0-9_]{3,20}$/.test(value))throw fail(400,'账号需为 3–20 位字母、数字或下划线');return value;}
function validateName(input,label='昵称',max=24){const value=string(input).trim();if(!value||value.length>max)throw fail(400,`${label}需为 1–${max} 个字`);return value;}
function passwordMatches(user,password){if(typeof password!=='string'||password.length>128)return false;const derived=scryptSync(password,user?.salt||'ichat-dummy-salt',64);return !!user&&timingSafeEqual(derived,Buffer.from(user.password_hash,'hex'));}
function ensureAvailable(username,phone,exceptId=''){if(db.prepare('SELECT 1 FROM users WHERE id<>? AND (username=? OR phone=?)').get(exceptId,username,username))throw fail(409,'这个账号已被使用，换一个试试');if(phone&&db.prepare('SELECT 1 FROM users WHERE id<>? AND (phone=? OR username=?)').get(exceptId,phone,phone))throw fail(409,'这个手机号已被使用');}
function findIdentifier(input){const identifier=string(input).trim().toLowerCase();if(!identifier||identifier.length>40)return null;const account=db.prepare('SELECT * FROM users WHERE username=?').get(identifier);if(account)return account;let phone;try{phone=normalizePhone(identifier);}catch{return null;}return phone?db.prepare('SELECT * FROM users WHERE phone=?').get(phone):null;}
function makeUser(username,displayName,password,phone=null){const salt=randomBytes(16).toString('hex'),id=randomUUID();db.prepare('INSERT INTO users(id,username,display_name,password_hash,salt,created_at,phone) VALUES(?,?,?,?,?,?,?)').run(id,username,displayName,scryptSync(password,salt,64).toString('hex'),salt,nowISO(),phone);return getUser(id);}
function issueSession(user,req,deviceName){const token=randomBytes(32).toString('base64url'),now=nowISO();db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,id,label,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)').run(hashToken(token),user.id,Date.now()+30*86400000,randomUUID(),features.sessionLabel(req,deviceName),now,now);return {token,user:selfUser(user)};}
function sessionFromToken(token){if(!token||token.length>200)return null;return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hashToken(token),Date.now());}
function requireSession(token){const user=sessionFromToken(token);if(!user)throw fail(401,'登录已过期，请重新登录');db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=? AND (last_seen_at IS NULL OR last_seen_at<?)').run(nowISO(),hashToken(token),new Date(Date.now()-60000).toISOString());return user;}
function pair(a,b){return [a,b].sort();}
function areFriends(a,b){const [x,y]=pair(a,b);return !!db.prepare('SELECT 1 FROM friendships WHERE user_a=? AND user_b=?').get(x,y);}
function addFriendship(a,b){const [x,y]=pair(a,b);db.prepare('INSERT OR IGNORE INTO friendships(user_a,user_b,created_at) VALUES(?,?,?)').run(x,y,nowISO());}
function friendIds(id){return db.prepare('SELECT CASE WHEN user_a=? THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a=? OR user_b=?').all(id,id,id).map(row=>row.id);}
function directConversation(a,b){const key=pair(a,b).join(':');let row=db.prepare('SELECT * FROM conversations WHERE direct_key=?').get(key);if(row)return row;return transaction(()=>{const id=randomUUID();db.prepare("INSERT INTO conversations(id,direct_key,created_at,kind) VALUES(?,?,?,'direct')").run(id,key,nowISO());for(const userId of [a,b])db.prepare('INSERT INTO members(conversation_id,user_id) VALUES(?,?)').run(id,userId);return db.prepare('SELECT * FROM conversations WHERE id=?').get(id);});}
if(demo){let lin=db.prepare('SELECT * FROM users WHERE username=?').get('lin'),chen=db.prepare('SELECT * FROM users WHERE username=?').get('chen');lin ||=makeUser('lin','小林','iChatDemo2026!');chen ||=makeUser('chen','陈序','iChatDemo2026!');addFriendship(lin.id,chen.id);const conversation=directConversation(lin.id,chen.id);if(!db.prepare('SELECT 1 FROM messages WHERE conversation_id=? LIMIT 1').get(conversation.id))for(const [sender,body]of [[chen,'iChat 已经准备好了，试着给我发一条消息吧。'],[lin,'收到！换个设备登录，也能接着聊。']])db.prepare('INSERT INTO messages(id,conversation_id,sender_id,client_id,body,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),conversation.id,sender.id,randomUUID(),body,new Date(Date.now()-120000).toISOString());}

const peers=new Map();
function sendTo(userId,event){for(const socket of peers.get(userId)||[])if(socket.readyState===WebSocket.OPEN){if(!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(socket.authTokenHash,Date.now())){socket.close(1000,'Session expired');continue;}if(socket.bufferedAmount>1024*1024){socket.close(1013,'Connection too slow');continue;}socket.send(JSON.stringify(event));}}
function relatedIds(id){return new Set([...friendIds(id),...db.prepare("SELECT DISTINCT b.user_id AS id FROM members a JOIN members b ON a.conversation_id=b.conversation_id JOIN conversations c ON c.id=a.conversation_id WHERE a.user_id=? AND c.kind='group' AND c.archived=0 AND b.user_id<>?").all(id,id).map(row=>row.id)].filter(other=>!features?.blockedEither(id,other)));}
function publishPresence(){for(const id of peers.keys()){const related=relatedIds(id);sendTo(id,{type:'presence',userIds:[...peers.keys()].filter(peer=>peer===id||related.has(peer))});}}
function relationshipChanged(a,b){features?.onRelationship(a,b);for(const id of [a,b])sendTo(id,{type:'relationship'});publishPresence();}
function membership(id,userId){return db.prepare('SELECT m.* FROM members m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND m.user_id=? AND c.archived=0').get(id,userId);}
function conversationMembers(id){return db.prepare('SELECT user_id FROM members WHERE conversation_id=?').all(id).map(row=>row.user_id);}
function messageView(row,viewer){return features.messageView(row,viewer);}
function conversationView(conversationId,userId){
  const conversation=db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId),member=membership(conversationId,userId);if(!conversation||!member)throw fail(403,'你无法访问这个会话');
  const partner=conversation.kind==='group'?{id:conversationId,username:'group',displayName:conversation.title,about:'',avatarId:conversation.avatar_id||null}:publicUser(db.prepare('SELECT u.* FROM users u JOIN members m ON m.user_id=u.id WHERE m.conversation_id=? AND u.id<>? LIMIT 1').get(conversationId,userId));
  const last=db.prepare('SELECT x.* FROM messages x WHERE conversation_id=? AND seq>=? AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=x.id) ORDER BY seq DESC LIMIT 1').get(conversationId,member.history_from_seq,userId);
  const unread=db.prepare('SELECT count(*) AS n FROM messages x WHERE conversation_id=? AND seq>? AND seq>=? AND sender_id<>? AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=x.id)').get(conversationId,member.read_seq,member.history_from_seq,userId,userId).n;
  return features.decorateConversation({id:conversationId,kind:conversation.kind,title:conversation.kind==='group'?conversation.title:partner.displayName,avatarId:conversation.kind==='group'?(conversation.avatar_id||null):partner.avatarId,ownerId:conversation.owner_id||null,memberCount:conversationMembers(conversationId).length,partner,lastMessage:last?messageView(last,userId):null,unread},userId);
}
function publishConversation(id){for(const userId of conversationMembers(id))sendTo(userId,{type:'conversation',conversation:conversationView(id,userId)});publishPresence();}
function insertMessage(conversationId,senderId,body,kind='text',mediaId=null,clientId=randomUUID()){const id=randomUUID();db.prepare('INSERT INTO messages(id,conversation_id,sender_id,client_id,body,created_at,kind,media_id) VALUES(?,?,?,?,?,?,?,?)').run(id,conversationId,senderId,clientId,body,nowISO(),kind,mediaId);return db.prepare('SELECT * FROM messages WHERE id=?').get(id);}
function publishMessage(row){features.onMessage(row);for(const userId of conversationMembers(row.conversation_id)){const member=membership(row.conversation_id,userId);if(member&&row.seq>=member.history_from_seq)sendTo(userId,{type:'message',message:messageView(row,userId),conversation:conversationView(row.conversation_id,userId)});}}
function groupInfo(id,userId){const conversation=db.prepare('SELECT * FROM conversations WHERE id=?').get(id);if(!conversation||conversation.kind!=='group'||!membership(id,userId))throw fail(403,'你无法访问这个群聊');return conversation;}
function checkAvatar(mediaId,userId){if(mediaId===null||mediaId==='')return null;if(typeof mediaId!=='string'||!db.prepare("SELECT 1 FROM media WHERE id=? AND owner_id=? AND purpose='avatar'").get(mediaId,userId))throw fail(400,'请使用自己上传的头像');return mediaId;}
function userIdsInput(value){if(!Array.isArray(value)||!value.length||value.length>99||value.some(id=>typeof id!=='string'||id.length>80))throw fail(400,'请选择 1–99 位好友');return [...new Set(value)];}
function requestView(row,viewer){return {id:row.id,user:publicUser(getUser(row.sender_id===viewer?row.receiver_id:row.sender_id)),status:row.status,message:row.message,createdAt:row.created_at};}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function readBytes(req,max){return new Promise((accept,reject)=>{let size=0,settled=false;const chunks=[];req.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>max){settled=true;chunks.length=0;reject(fail(413,'文件或内容太大，请缩小后重试'));}else chunks.push(chunk);});req.on('end',()=>{if(!settled){settled=true;accept(Buffer.concat(chunks,size));}});req.on('error',error=>{if(!settled){settled=true;reject(error);}});req.on('aborted',()=>{if(!settled){settled=true;reject(fail(400,'上传中断，请重试'));}});});}
async function body(req,max=16384){const bytes=await readBytes(req,max);try{const value=JSON.parse(bytes.toString('utf8')||'{}');if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw fail(400,'请求格式不正确');}}
const rateBuckets=new Map();
function clientIp(req){const remote=req.socket.remoteAddress||'unknown';if(process.env.TRUST_PROXY==='loopback'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){const forwarded=req.headers['x-real-ip'];if(typeof forwarded==='string'&&isIP(forwarded))return forwarded;}return remote;}
function rateLimit(req,key,max,windowMs,identity=clientIp(req)){const id=`${identity}:${key}`,now=Date.now();let bucket=rateBuckets.get(id);if(!bucket||bucket.until<=now){bucket={count:0,until:now+windowMs};rateBuckets.set(id,bucket);}if(++bucket.count>max)throw fail(429,'操作太频繁，请稍后再试');if(rateBuckets.size>10000){for(const [key,value]of rateBuckets)if(value.until<=now)rateBuckets.delete(key);if(rateBuckets.size>20000)rateBuckets.delete(rateBuckets.keys().next().value);}}

const maxImageBytes=3*1024*1024;
function validateImage(bytes,declared){
  let mime,extension,width,height;
  if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    if(bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw fail(400,'PNG 图片格式不完整');width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);let offset=8,sawEnd=false,sawData=false;
    while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(length>maxImageBytes||offset+length+12>bytes.length)throw fail(400,'PNG 图片格式不完整');if(type==='IDAT')sawData=true;offset+=length+12;if(type==='IEND'){sawEnd=length===0&&offset===bytes.length;break;}}
    if(!sawEnd||!sawData)throw fail(400,'PNG 图片格式不完整');mime='image/png';extension='png';
  }else if(bytes.length>=20&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2;while(offset+4<bytes.length){if(bytes[offset]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);}offset+=length;}
    if(!width||!height)throw fail(400,'JPEG 图片格式不完整');mime='image/jpeg';extension='jpg';
  }else if(bytes.length>=25&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8){
    let offset=12,valid=false;while(offset+8<=bytes.length){const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),data=offset+8;if(length>maxImageBytes||data+length>bytes.length)throw fail(400,'WebP 图片格式不完整');
      if(type==='VP8X'&&length>=10){width=bytes.readUIntLE(data+4,3)+1;height=bytes.readUIntLE(data+7,3)+1;}
      if(type==='VP8 '&&length>=10&&bytes[data+3]===0x9d&&bytes[data+4]===1&&bytes[data+5]===0x2a){width=bytes.readUInt16LE(data+6)&0x3fff;height=bytes.readUInt16LE(data+8)&0x3fff;valid=true;}
      if(type==='VP8L'&&length>=5&&bytes[data]===0x2f){const bits=bytes.readUInt32LE(data+1);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;valid=true;}offset=data+length+(length%2);
    }if(!valid||offset!==bytes.length)throw fail(400,'请选择静态 WebP 图片');mime='image/webp';extension='webp';
  }else throw fail(400,'请选择完整的 JPEG、PNG 或静态 WebP 图片');
  if(width<1||height<1||width>10000||height>10000||width*height>25000000)throw fail(400,'图片尺寸过大，请先缩小图片');if(declared!==mime)throw fail(400,'图片类型与实际内容不一致');return {mime,extension};
}
let activeUploads=0;
function uploadRules(req,url){
  const purpose=url.searchParams.get('purpose'),mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  const image=['message','avatar','moment'].includes(purpose),voice=purpose==='voice',file=purpose==='file';
  if(!image&&!voice&&!file)throw fail(400,'请选择上传用途');
  if(image&&!['image/jpeg','image/png','image/webp'].includes(mime)||voice&&!['audio/webm','audio/ogg','audio/mp4'].includes(mime)||file&&mime!=='application/octet-stream')throw fail(415,'不支持这个文件格式');
  let filename=null;
  if(file){let value;try{value=decodeURIComponent(String(req.headers['x-file-name']||''));}catch{throw fail(400,'文件名编码不正确');}value=value.replaceAll('\\','/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g,'').trim();if(!value||value==='.'||value==='..'||value.length>120)throw fail(400,'文件名需为 1–120 个字');filename=value;}
  return {purpose,mime,filename,max:image?3*1024*1024:voice?5*1024*1024:10*1024*1024,image,voice,file};
}
function validateVoice(bytes,mime){
  const webm=bytes.length>=16&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&(bytes.subarray(0,256).includes(Buffer.from('webm'))||bytes.subarray(0,256).includes(Buffer.from('matroska')));
  const ogg=bytes.length>=32&&bytes.toString('ascii',0,4)==='OggS'&&bytes[4]===0&&(bytes.subarray(0,256).includes(Buffer.from('OpusHead'))||bytes.subarray(0,256).includes(Buffer.from('vorbis')));
  const mp4=bytes.length>=20&&bytes.toString('ascii',4,8)==='ftyp'&&bytes.readUInt32BE(0)>=16&&bytes.readUInt32BE(0)<=bytes.length;
  if(!(mime==='audio/webm'&&webm||mime==='audio/ogg'&&ogg||mime==='audio/mp4'&&mp4))throw fail(400,'语音容器格式不正确');
  return {mime,extension:mime==='audio/webm'?'webm':mime==='audio/ogg'?'ogg':'m4a'};
}
async function uploadMedia(req,res,user,url,token){
  const rules=uploadRules(req,url),length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>rules.max)throw fail(413,`文件不能超过 ${rules.max/1024/1024} MiB`);
  if(activeUploads>=3)throw fail(429,'上传繁忙，请稍后重试');rateLimit(req,'upload-ip',120,3600000);rateLimit(req,'upload-user',40,3600000,user.id);
  const usage=()=>db.prepare('SELECT coalesce(sum(size),0) AS total,coalesce(sum(CASE WHEN created_at>=? THEN size ELSE 0 END),0) AS today FROM media WHERE owner_id=?').get(new Date(Date.now()-86400000).toISOString(),user.id);
  const quota=usage();if(quota.total>=200*1024*1024||quota.today>=50*1024*1024)throw fail(429,'文件上传额度已用完，请稍后再试');const disk=statfsSync(mediaDir);if(disk.bavail*disk.bsize<100*1024*1024+rules.max)throw fail(507,'服务器存储空间暂时不足');
  activeUploads++;
  try{const bytes=await readBytes(req,rules.max);user=requireSession(token);if(!bytes.length)throw fail(400,'不能上传空文件');const current=usage();if(current.total+bytes.length>200*1024*1024||current.today+bytes.length>50*1024*1024)throw fail(429,'文件上传额度已用完，请稍后再试');let checked;
    try{checked=rules.image?validateImage(bytes,rules.mime):rules.voice?validateVoice(bytes,rules.mime):{mime:rules.mime,extension:'bin'};}catch(error){throw error.status?error:fail(400,'文件格式不完整，请重新选择');}
    // Receiving a body can take time: reserve free space again at the actual write.
    const currentDisk=statfsSync(mediaDir);if(currentDisk.bavail*currentDisk.bsize<100*1024*1024+bytes.length)throw fail(507,'服务器存储空间暂时不足');
    const id=randomUUID(),filename=`${id}.${checked.extension}`,path=resolve(mediaDir,filename);let fd,created=false,persisted=false;
    try{fd=openSync(path,'wx',0o600);created=true;writeFileSync(fd,bytes);closeSync(fd);fd=undefined;db.prepare('INSERT INTO media(id,owner_id,purpose,mime,size,filename,original_filename,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,rules.purpose,checked.mime,bytes.length,filename,rules.filename,nowISO());persisted=true;}
    catch(error){if(['ENOSPC','EDQUOT'].includes(error.code))throw fail(507,'服务器存储空间暂时不足');throw error;}
    finally{if(fd!==undefined)try{closeSync(fd);}catch{}if(created&&!persisted)try{unlinkSync(path);}catch{}}
    json(res,201,{media:features.mediaView(db.prepare('SELECT * FROM media WHERE id=?').get(id))});
  }finally{activeUploads--;}
}
function serveMedia(req,res,id,user){
  const media=db.prepare('SELECT * FROM media WHERE id=?').get(id);if(!media)throw fail(404,'文件不存在');
  const canView=media.owner_id===user.id||!!db.prepare('SELECT 1 FROM users WHERE avatar_id=?').get(id)||!!db.prepare('SELECT 1 FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE c.avatar_id=? AND m.user_id=? AND c.archived=0').get(id,user.id)||!!db.prepare('SELECT 1 FROM messages x JOIN members m ON m.conversation_id=x.conversation_id JOIN conversations c ON c.id=x.conversation_id WHERE x.media_id=? AND m.user_id=? AND x.seq>=m.history_from_seq AND x.withdrawn_at IS NULL AND c.archived=0 AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=x.id)').get(id,user.id,user.id)||features.mediaAllowed(id,user.id);
  if(!canView)throw fail(403,'你无法查看这个文件');const path=resolve(mediaDir,media.filename);if(dirname(path)!==mediaDir||!existsSync(path))throw fail(404,'文件不存在');const disposition=media.purpose==='file'?`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(media.original_filename||'附件').replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`:'inline';
  res.writeHead(200,{'Content-Type':media.mime,'Content-Length':media.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':disposition});if(req.method==='HEAD')res.end();else{const stream=createReadStream(path);stream.on('error',()=>res.destroy());stream.pipe(res);}
}

features=createFeatures({db,transaction,publicUser,getUser,fail,string,nowISO,areFriends,friendIds,membership,conversationMembers,conversationView,sendTo,publishConversation,publishMessage,insertMessage,body,json,requireSession,rateLimit,relationshipChanged,publishPresence,validateName,checkAvatar,calls:()=>calls,closeSession:hash=>{for(const sockets of peers.values())for(const socket of sockets)if(socket.authTokenHash===hash)socket.close(1000,'Device signed out');}});
const enterprise=createEnterprise({db,transaction,body,json,requireSession,rateLimit,fail,nowISO});
const workflows=createWorkflows({db,transaction,body,json,requireSession,rateLimit,fail,nowISO,getUser});
const demoEnterprise=createDemoEnterprise({json,fail});
const calls=createCallHub({publicUser:id=>publicUser(getUser(id)),canCall:(a,b)=>areFriends(a,b)&&!features.blockedEither(a,b),isSocketValid:ws=>!!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(ws.authTokenHash,Date.now()),notify:sendTo,onEnded:info=>{const conversation=directConversation(info.callerId,info.calleeId),mode=info.mode==='video'?'视频':'语音',seconds=Math.max(0,Math.round(info.durationSeconds??info.durationMs/1000)||0),summary=seconds?`[${mode}通话] ${seconds}秒`:`[${mode}通话] ${info.reason==='rejected'?'对方未接听':['timeout','missed'].includes(info.reason)?'未接通':'已结束'}`,row=insertMessage(conversation.id,info.callerId,summary,'call',null,'call_'+info.id);db.prepare('UPDATE messages SET duration_ms=? WHERE id=?').run(Math.max(0,info.durationMs||0),row.id);publishMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(row.id));}});

const allowedOrigins=new Set((process.env.ALLOWED_ORIGINS||'http://localhost,https://localhost,capacitor://localhost,http://127.0.0.1:4690').split(',').map(value=>value.trim()));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ttf':'font/ttf','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json'};
const contentSecurityPolicy=`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; connect-src 'self' http: https: ws: wss:; frame-src 'self'; frame-ancestors 'self'${demo?' http://127.0.0.1:4690':''}`;
const server=http.createServer(async(req,res)=>{try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',contentSecurityPolicy);
  const origin=req.headers.origin,sameOrigin=origin===`http://${req.headers.host}`||origin===`https://${req.headers.host}`;
  if(origin&&(sameOrigin||allowedOrigins.has(origin))){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-File-Name');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,DELETE,OPTIONS');res.setHeader('Access-Control-Expose-Headers','Content-Disposition,Content-Type,Content-Length');}else if(origin)throw fail(403,'这个应用来源尚未被服务器允许');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const url=new URL(req.url,'http://localhost'),route=url.pathname;
  if(route==='/api/health'&&req.method==='GET'){json(res,200,{ok:true,app:'iChat',version:'1.2.0',demo,features:['phone-password','friends','groups','photos','profile','voice','files','location','contact-cards','message-actions','favorites','moments','devices','notifications','calls','ai-assistant','enterprise-workspace']});return;}
  if(route==='/api/register'&&req.method==='POST'){
    rateLimit(req,'register',15,3600000);const input=await body(req),phone=normalizePhone(input.phone),displayName=validateName(input.displayName),password=validatePassword(input.password);
    if(!input.username&&!phone)throw fail(400,'请填写手机号或账号');const username=input.username?validateUsername(input.username):'u_'+randomBytes(6).toString('hex');ensureAvailable(username,phone);json(res,201,issueSession(makeUser(username,displayName,password,phone),req,input.deviceName));return;
  }
  if(route==='/api/login'&&req.method==='POST'){rateLimit(req,'login',25,60000);const input=await body(req),user=findIdentifier(input.identifier||input.username);if(!passwordMatches(user,input.password))throw fail(401,'账号、手机号或密码不正确');json(res,200,issueSession(user,req,input.deviceName));return;}
  if(route==='/api/demo/login'&&req.method==='POST'){if(!demo)throw fail(404,'演示模式未开启');rateLimit(req,'demo',60,60000);const input=await body(req);if(!['lin','chen'].includes(input.username))throw fail(400,'请选择演示账号');json(res,200,issueSession(db.prepare('SELECT * FROM users WHERE username=?').get(input.username),req,input.deviceName));return;}
  if(route.startsWith('/api/')){
    rateLimit(req,'api-ip',1200,60000);const token=String(req.headers.authorization||'').replace(/^Bearer /,'');let user=requireSession(token);rateLimit(req,'api-user',360,60000,user.id);
    // Receiving a request body yields to other requests. Authorize again afterwards,
    // so logout, password changes and updated account data take effect before any write.
    if(await enterprise.handle(req,res,url,user,token))return;
    if(demoEnterprise.handle(req,res,url))return;
    if(await workflows.handle(req,res,url,user,token))return;
    if(await features.handle(req,res,url,user,token))return;
    user=requireSession(token);
    if(route==='/api/me'&&req.method==='GET'){json(res,200,{user:selfUser(user)});return;}
    if(route==='/api/me'&&req.method==='POST'){
      const input=await body(req);user=requireSession(token);const displayName=validateName(input.displayName??user.display_name),username=input.username===undefined?user.username:validateUsername(input.username),about=input.about===undefined?user.about:string(input.about).trim();if(about.length>160)throw fail(400,'个性签名不能超过 160 个字');
      const phone=input.phone===undefined?user.phone:normalizePhone(input.phone);if(phone!==user.phone&&!passwordMatches(user,input.currentPassword))throw fail(400,'修改手机号需要验证当前密码');const avatarId=input.avatarId===undefined?user.avatar_id:checkAvatar(input.avatarId,user.id);ensureAvailable(username,phone,user.id);
      db.prepare('UPDATE users SET username=?,display_name=?,about=?,phone=?,avatar_id=? WHERE id=?').run(username,displayName,about,phone,avatarId,user.id);const updated=getUser(user.id);for(const id of new Set([user.id,...relatedIds(user.id)]))sendTo(id,{type:'profile',user:publicUser(updated)});json(res,200,{user:selfUser(updated)});return;
    }
    if(route==='/api/password'&&req.method==='POST'){
      rateLimit(req,'password',10,60000,user.id);const input=await body(req);user=requireSession(token);if(!passwordMatches(user,input.currentPassword))throw fail(400,'当前密码不正确');const password=validatePassword(input.newPassword),salt=randomBytes(16).toString('hex');transaction(()=>{db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').run(scryptSync(password,salt,64).toString('hex'),salt,user.id);db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id,hashToken(token));});for(const socket of peers.get(user.id)||[])if(socket.authTokenHash!==hashToken(token))socket.close(1000,'Password changed');json(res,200,{ok:true});return;
    }
    if(route==='/api/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));for(const socket of peers.get(user.id)||[])if(socket.authTokenHash===hashToken(token))socket.close(1000,'Signed out');json(res,200,{ok:true});return;}
    if(route==='/api/contacts'&&req.method==='GET'){json(res,200,{users:friendIds(user.id).map(getUser).map(publicUser).sort((a,b)=>a.displayName.localeCompare(b.displayName))});return;}
    if(route==='/api/users/search'&&req.method==='GET'){
      rateLimit(req,'search',60,60000,user.id);const target=findIdentifier(url.searchParams.get('q'));let relationship='none';if(target){if(target.id===user.id)relationship='self';else if(areFriends(user.id,target.id))relationship='friend';else if(db.prepare("SELECT 1 FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending'").get(user.id,target.id))relationship='outgoing';else if(db.prepare("SELECT 1 FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending'").get(target.id,user.id))relationship='incoming';}json(res,200,{users:target?[publicUser(target)]:[],relationship});return;
    }
    if(route==='/api/friend-requests'&&req.method==='GET'){
      const incoming=db.prepare("SELECT * FROM friend_requests WHERE receiver_id=? AND status='pending' ORDER BY created_at DESC LIMIT 200").all(user.id).map(row=>requestView(row,user.id));const outgoing=db.prepare('SELECT * FROM friend_requests WHERE sender_id=? ORDER BY created_at DESC LIMIT 200').all(user.id).map(row=>requestView(row,user.id));json(res,200,{incoming,outgoing});return;
    }
    if(route==='/api/friend-requests'&&req.method==='POST'){
      rateLimit(req,'friend-request',30,3600000,user.id);const input=await body(req);user=requireSession(token);const target=findIdentifier(input.identifier),message=string(input.message).trim();if(!target)throw fail(404,'没有找到这个账号或手机号');if(target.id===user.id)throw fail(400,'不能添加自己为好友');if(message.length>160)throw fail(400,'好友申请不能超过 160 个字');if(areFriends(user.id,target.id))throw fail(409,'你们已经是好友');
      const outgoing=db.prepare("SELECT * FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending'").get(user.id,target.id);if(outgoing){json(res,200,{request:requestView(outgoing,user.id)});return;}
      const incoming=db.prepare("SELECT * FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending'").get(target.id,user.id);if(incoming){json(res,409,{error:'对方已经向你发送申请，请在新的朋友中处理',requestId:incoming.id});return;}
      if(friendIds(user.id).length>=500||friendIds(target.id).length>=500)throw fail(409,'好友数量已达上限');if(db.prepare("SELECT count(*) AS n FROM friend_requests WHERE sender_id=? AND status='pending'").get(user.id).n>=100||db.prepare("SELECT count(*) AS n FROM friend_requests WHERE receiver_id=? AND status='pending'").get(target.id).n>=200)throw fail(429,'待处理申请过多，请稍后重试');
      const id=randomUUID();db.prepare('INSERT INTO friend_requests(id,sender_id,receiver_id,message,created_at) VALUES(?,?,?,?,?)').run(id,user.id,target.id,message,nowISO());relationshipChanged(user.id,target.id);json(res,201,{request:requestView(db.prepare('SELECT * FROM friend_requests WHERE id=?').get(id),user.id)});return;
    }
    const respond=route.match(/^\/api\/friend-requests\/([^/]+)\/respond$/);
    if(respond&&req.method==='POST'){
      const input=await body(req);user=requireSession(token);const request=db.prepare('SELECT * FROM friend_requests WHERE id=?').get(respond[1]);if(!request||request.receiver_id!==user.id)throw fail(403,'你无法处理这条申请');if(!['accept','reject'].includes(input.action))throw fail(400,'请选择接受或拒绝');if(request.status!=='pending')throw fail(409,'这条申请已经处理过了');if(input.action==='accept'&&(friendIds(user.id).length>=500||friendIds(request.sender_id).length>=500))throw fail(409,'好友数量已达上限');transaction(()=>{if(input.action==='accept')addFriendship(user.id,request.sender_id);db.prepare('UPDATE friend_requests SET status=?,responded_at=? WHERE id=?').run(input.action==='accept'?'accepted':'rejected',nowISO(),request.id);});relationshipChanged(user.id,request.sender_id);json(res,200,{request:requestView(db.prepare('SELECT * FROM friend_requests WHERE id=?').get(request.id),user.id)});return;
    }
    const removeFriend=route.match(/^\/api\/friends\/([^/]+)\/remove$/);
    if(removeFriend&&req.method==='POST'){const target=removeFriend[1];if(!areFriends(user.id,target))throw fail(404,'这个联系人不在好友列表中');const [a,b]=pair(user.id,target);db.prepare('DELETE FROM friendships WHERE user_a=? AND user_b=?').run(a,b);relationshipChanged(user.id,target);json(res,200,{ok:true});return;}
    if(route==='/api/media'&&req.method==='POST'){await uploadMedia(req,res,user,url,token);return;}
    const mediaMatch=route.match(/^\/api\/media\/([a-f0-9-]{36})$/);if(mediaMatch&&['GET','HEAD'].includes(req.method)){serveMedia(req,res,mediaMatch[1],user);return;}
    if(route==='/api/conversations'&&req.method==='GET'){const rows=db.prepare('SELECT m.conversation_id FROM members m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id=? AND c.archived=0').all(user.id).map(row=>conversationView(row.conversation_id,user.id));rows.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(b.lastMessage?.seq||0)-(a.lastMessage?.seq||0));json(res,200,{conversations:rows});return;}
    if(route==='/api/conversations'&&req.method==='POST'){const input=await body(req);user=requireSession(token);if(typeof input.userId!=='string'||input.userId===user.id||!getUser(input.userId))throw fail(400,'请选择有效的联系人');if(!areFriends(user.id,input.userId)||features.blockedEither(user.id,input.userId))throw fail(403,'暂时无法开始对话，请确认好友关系');const conversation=directConversation(user.id,input.userId);json(res,200,{conversation:conversationView(conversation.id,user.id)});return;}
    if(route==='/api/groups'&&req.method==='POST'){
      rateLimit(req,'group-create',20,3600000,user.id);const input=await body(req);user=requireSession(token);const name=validateName(input.name,'群名称',40),ids=userIdsInput(input.userIds).filter(id=>id!==user.id);if(!ids.length)throw fail(400,'请至少选择一位好友');if(ids.some(id=>!areFriends(user.id,id)))throw fail(403,'只能邀请自己的好友入群');if(db.prepare("SELECT count(*) AS n FROM conversations WHERE kind='group' AND owner_id=?").get(user.id).n>=100)throw fail(429,'创建的群聊数量已达上限');
      const id=randomUUID();let creation;transaction(()=>{db.prepare("INSERT INTO conversations(id,direct_key,created_at,kind,title,owner_id) VALUES(?,?,?,'group',?,?)").run(id,'group:'+id,nowISO(),name,user.id);for(const memberId of [user.id,...ids])db.prepare('INSERT INTO members(conversation_id,user_id,role) VALUES(?,?,?)').run(id,memberId,memberId===user.id?'owner':'member');creation=insertMessage(id,user.id,`${user.display_name} 创建了群聊`,'system');});publishConversation(id);publishMessage(creation);json(res,201,{conversation:conversationView(id,user.id)});return;
    }
    const groupMatch=route.match(/^\/api\/groups\/([^/]+)(?:\/(members|remove|leave))?$/);
    if(groupMatch){
      const [,id,operation]=groupMatch;let group=groupInfo(id,user.id);
      if(!operation&&req.method==='GET'){const members=db.prepare('SELECT u.*,m.role FROM users u JOIN members m ON u.id=m.user_id WHERE m.conversation_id=? ORDER BY m.role DESC,u.display_name').all(id).map(row=>({...publicUser(row),role:row.role}));json(res,200,{conversation:conversationView(id,user.id),members});return;}
      if(!operation&&req.method==='POST'){if(group.owner_id!==user.id)throw fail(403,'只有群主可以编辑群资料');const input=await body(req);user=requireSession(token);group=groupInfo(id,user.id);if(group.owner_id!==user.id)throw fail(403,'只有群主可以编辑群资料');const name=input.name===undefined?group.title:validateName(input.name,'群名称',40),avatar=input.avatarId===undefined?group.avatar_id:checkAvatar(input.avatarId,user.id);db.prepare('UPDATE conversations SET title=?,avatar_id=? WHERE id=?').run(name,avatar,id);publishConversation(id);json(res,200,{conversation:conversationView(id,user.id)});return;}
      if(operation==='members'&&req.method==='POST'){
        rateLimit(req,'group-invite',40,3600000,user.id);const input=await body(req);user=requireSession(token);group=groupInfo(id,user.id);const ids=userIdsInput(input.userIds).filter(memberId=>!membership(id,memberId));if(!ids.length)throw fail(409,'所选联系人已经在群里');if(ids.some(memberId=>!areFriends(user.id,memberId)))throw fail(403,'只能邀请自己的好友入群');if(conversationMembers(id).length+ids.length>100)throw fail(409,'群聊最多支持 100 人');let join;
        transaction(()=>{const boundary=db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM messages').get().seq;for(const memberId of ids)db.prepare('INSERT INTO members(conversation_id,user_id,history_from_seq,read_seq) VALUES(?,?,?,?)').run(id,memberId,boundary,boundary-1);join=insertMessage(id,user.id,`${user.display_name} 邀请了 ${ids.length} 位好友加入群聊`,'system');});publishConversation(id);publishMessage(join);json(res,200,{conversation:conversationView(id,user.id)});return;
      }
      if(operation==='remove'&&req.method==='POST'){if(group.owner_id!==user.id)throw fail(403,'只有群主可以移出群成员');const input=await body(req);user=requireSession(token);group=groupInfo(id,user.id);if(group.owner_id!==user.id)throw fail(403,'只有群主可以移出群成员');const target=string(input.userId);if(target===user.id)throw fail(400,'退出群聊请使用退出操作');if(!membership(id,target))throw fail(404,'这个用户不在群聊中');let removal;transaction(()=>{db.prepare('DELETE FROM members WHERE conversation_id=? AND user_id=?').run(id,target);removal=insertMessage(id,user.id,`${getUser(target).display_name} 已被移出群聊`,'system');});sendTo(target,{type:'conversation-removed',conversationId:id});publishConversation(id);publishMessage(removal);json(res,200,{ok:true});return;}
      if(operation==='leave'&&req.method==='POST'){await body(req);user=requireSession(token);group=groupInfo(id,user.id);let leaving;transaction(()=>{db.prepare('DELETE FROM members WHERE conversation_id=? AND user_id=?').run(id,user.id);if(group.owner_id===user.id){const successor=db.prepare('SELECT user_id FROM members WHERE conversation_id=? ORDER BY rowid LIMIT 1').get(id);db.prepare('UPDATE conversations SET owner_id=? WHERE id=?').run(successor?.user_id||null,id);if(successor)db.prepare("UPDATE members SET role='owner' WHERE conversation_id=? AND user_id=?").run(id,successor.user_id);}leaving=insertMessage(id,user.id,`${user.display_name} 退出了群聊`,'system');});sendTo(user.id,{type:'conversation-removed',conversationId:id});publishConversation(id);publishMessage(leaving);json(res,200,{ok:true});return;}
    }
    const match=route.match(/^\/api\/conversations\/([^/]+)\/(messages|read)$/);
    if(match){
      const [,conversationId,operation]=match;let member=membership(conversationId,user.id);if(!member)throw fail(403,'你无法访问这个会话');
      if(operation==='messages'&&req.method==='GET'){const rawBefore=url.searchParams.get('before'),before=rawBefore?Number(rawBefore):Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(before)||before<1)throw fail(400,'历史消息页码不正确');const rows=db.prepare('SELECT x.* FROM messages x WHERE conversation_id=? AND seq<? AND seq>=? AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.user_id=? AND h.message_id=x.id) ORDER BY seq DESC LIMIT 51').all(conversationId,before,member.history_from_seq,user.id);json(res,200,{messages:rows.slice(0,50).reverse().map(row=>messageView(row,user.id)),hasMore:rows.length>50});return;}
      if(operation==='messages'&&req.method==='POST'){
        const input=await body(req);user=requireSession(token);member=membership(conversationId,user.id);if(!member)throw fail(403,'你无法访问这个会话');const kind=input.kind??'text',clientId=string(input.clientId),text=kind==='image'?'[图片]':string(input.body).trim(),mediaId=kind==='image'?string(input.mediaId):null;
        if(!['text','image'].includes(kind))throw fail(400,'不支持这个消息类型');if(kind==='text'&&(!text||text.length>2000))throw fail(400,'消息需为 1–2000 个字');if(kind==='image'&&input.body!==undefined&&input.body!==''&&input.body!=='[图片]')throw fail(400,'图片消息不能附带文字');if(kind==='text'&&input.mediaId)throw fail(400,'文字消息不能附带图片');if(!/^[a-zA-Z0-9_-]{16,80}$/.test(clientId))throw fail(400,'消息标识不正确');
        const previous=db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_id=?').get(user.id,clientId);if(previous){if(previous.conversation_id!==conversationId||previous.body!==text||previous.kind!==kind||previous.media_id!==mediaId||previous.seq<member.history_from_seq)throw fail(409,'消息标识已用于其他内容');json(res,200,{message:messageView(previous)});return;}
        const conversation=db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);if(conversation.kind==='direct'){const partner=conversationMembers(conversationId).find(id=>id!==user.id);if(!areFriends(user.id,partner))throw fail(403,'请先添加对方为好友');}
        if(kind==='image'&&!db.prepare("SELECT 1 FROM media WHERE id=? AND owner_id=? AND purpose='message'").get(mediaId,user.id))throw fail(403,'只能发送自己上传的聊天图片');rateLimit(req,'message',120,60000,user.id);const row=insertMessage(conversationId,user.id,text,kind,mediaId,clientId);publishMessage(row);json(res,201,{message:messageView(row)});return;
      }
      if(operation==='read'&&req.method==='POST'){await body(req);user=requireSession(token);member=membership(conversationId,user.id);if(!member)throw fail(403,'你无法访问这个会话');const latest=db.prepare('SELECT coalesce(max(seq),0) AS seq FROM messages WHERE conversation_id=? AND seq>=?').get(conversationId,member.history_from_seq).seq;db.prepare('UPDATE members SET read_seq=max(read_seq,?),marked_unread=0 WHERE conversation_id=? AND user_id=?').run(latest,conversationId,user.id);sendTo(user.id,{type:'read',conversationId});json(res,200,{ok:true});return;}
    }
    throw fail(404,'没有找到这个接口');
  }
  if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'不支持这个请求方法');
  const dist=resolve(root,'dist');let file=resolve(dist,'.'+decodeURIComponent(route));
  // Website visitors see the public home page; account QR links and the existing
  // embedded demo keep opening the application. Native clients use /index.html.
  if(route==='/'&&!['add','demo','native'].some(key=>url.searchParams.has(key))&&existsSync(resolve(dist,'home.html')))file=resolve(dist,'home.html');
  if(!file.startsWith(dist+sep)&&file!==dist)throw fail(403,'路径不可访问');if(!existsSync(file)||statSync(file).isDirectory()){if(extname(route))throw fail(404,'文件不存在');file=resolve(dist,route==='/showcase'?'showcase.html':'index.html');}if(!existsSync(file))throw fail(503,'请先运行 npm run build');res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public,max-age=300'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
}catch(error){const status=error.status||500;if(status===500)console.error('Request failed:',error.message);if(!res.headersSent)json(res,status,{error:status===500?'服务器暂时出了点问题，请重试':error.message});else res.end();}});
server.requestTimeout=20000;server.headersTimeout=15000;
const wss=new WebSocketServer({noServer:true,maxPayload:96*1024,handleProtocols:protocols=>protocols.has('ichat.v1')?'ichat.v1':false});
server.on('upgrade',(req,socket,head)=>{try{
  if(new URL(req.url,'http://localhost').pathname!=='/ws'){socket.destroy();return;}rateLimit(req,'ws',60,60000);const origin=req.headers.origin;if(origin&&!allowedOrigins.has(origin)&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(value=>value.trim()),token=protocols.find(value=>value!=='ichat.v1'),user=sessionFromToken(token);if(!user){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}if((peers.get(user.id)?.size||0)>=8){socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>{ws.userId=user.id;ws.authTokenHash=hashToken(token);ws.alive=true;ws.on('pong',()=>ws.alive=true);const sockets=peers.get(user.id)||new Set();sockets.add(ws);peers.set(user.id,sockets);ws.on('message',raw=>{try{const current=requireSession(token);calls.handle(ws,raw,current);}catch{ws.close(1008,'Session expired');}});ws.on('close',()=>{calls.detach(ws);sockets.delete(ws);if(!sockets.size)peers.delete(user.id);publishPresence();});ws.on('error',()=>ws.terminate());publishPresence();});
}catch{socket.destroy();}});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){const active=db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(ws.authTokenHash,Date.now());if(!ws.alive||!active){ws.terminate();continue;}ws.alive=false;ws.ping();}},30000);heartbeat.unref();
server.listen(port,host,()=>console.log(`iChat 1.2.0 listening on http://${host}:${server.address().port}${demo?' (DEMO MODE)':''}`));
let closing=false;function shutdown(){if(closing)return;closing=true;clearInterval(heartbeat);enterprise.close();calls.close();for(const socket of wss.clients)socket.close(1001,'Server restarting');server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(0),2000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('message',message=>{if(message==='shutdown')shutdown();});
