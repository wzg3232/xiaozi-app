import qrcode from './vendor-qrcode.js';
import jsQR from './vendor-jsqr.js';
import {requestPermission,isNative} from './native.js';

let dialog=null,stream=null,scanTimer=null,generation=0;
const usernamePattern=/^[a-zA-Z0-9_]{3,20}$/;
export function parseUserCode(text){
  try{
    const raw=String(text).trim(),plain=/^ichat:\/\/user\/([a-zA-Z0-9_]{3,20})$/.exec(raw);
    if(plain)return plain[1];
    const url=new URL(raw);let value;
    if(url.protocol==='ichat:'&&url.hostname==='user'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash)value=decodeURIComponent(url.pathname.slice(1));
    else if(url.origin==='https://chat.pvdust.com'&&url.pathname==='/'&&!url.username&&!url.password&&!url.hash&&[...url.searchParams.keys()].every(k=>k==='add')&&url.searchParams.getAll('add').length===1)value=url.searchParams.get('add');
    return usernamePattern.test(value||'')?value:null;
  }catch{return null;}
}
function stopCamera(){clearTimeout(scanTimer);scanTimer=null;stream?.getTracks().forEach(track=>track.stop());stream=null;}
export function closeQr(){generation++;stopCamera();if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}}
function makeDialog(title,notify){
  closeQr();const ticket=generation;dialog=document.createElement('dialog');dialog.className='qr-dialog';
  const heading=document.createElement('h2');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.className='button secondary';close.textContent='关闭';close.addEventListener('click',closeQr);
  dialog.append(heading,close);document.body.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();closeQr();});dialog.showModal();
  const error=message=>{if(ticket===generation)notify?.(message);};return {ticket,panel:dialog,close,error};
}
export function showMyCode(user,{notify}={}){
  if(!usernamePattern.test(user?.username||'')){notify?.('当前账号暂时无法生成二维码');return;}
  const {panel,close}=makeDialog('我的二维码',notify),qr=qrcode(0,'M');qr.addData('ichat://user/'+user.username);qr.make();
  const count=qr.getModuleCount(),cell=8,margin=4,canvas=document.createElement('canvas');canvas.width=canvas.height=(count+margin*2)*cell;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#351741';
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(qr.isDark(row,col))ctx.fillRect((col+margin)*cell,(row+margin)*cell,cell,cell);
  const image=document.createElement('img');image.className='personal-qr';image.src=canvas.toDataURL('image/png');image.alt='小紫在 账号二维码：'+user.username;
  const name=document.createElement('p');name.textContent=(user.displayName||user.username)+' · @'+user.username;
  const note=document.createElement('p');note.className='hint';note.textContent='让朋友用小紫在扫一扫添加你。二维码只包含账号。';panel.insertBefore(image,close);panel.insertBefore(name,close);panel.insertBefore(note,close);
}
export async function scanCode({notify,onUser}={}){
  const {panel,close,ticket,error}=makeDialog('扫一扫',notify);
  const video=document.createElement('video');video.className='qr-camera';video.autoplay=true;video.muted=true;video.playsInline=true;video.hidden=true;
  const note=document.createElement('p');note.className='hint';note.textContent='扫描小紫在个人二维码，或从相册选择二维码图片。';
  const camera=document.createElement('button');camera.type='button';camera.className='button';camera.textContent='使用相机扫描';
  const album=document.createElement('button');album.type='button';album.className='button secondary';album.textContent='从相册选择';
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;
  panel.insertBefore(video,close);panel.insertBefore(note,close);panel.insertBefore(camera,close);panel.insertBefore(album,close);panel.insertBefore(input,close);
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const found=text=>{if(ticket!==generation)return false;const username=parseUserCode(text);if(!username){note.textContent='这不是小紫在个人二维码，请对准朋友的小紫在二维码。';return false;}closeQr();onUser?.(username);return true;};
  const decode=(source,width,height)=>{if(!width||!height)return null;const ratio=Math.min(1,1440/Math.max(width,height));canvas.width=Math.max(1,Math.floor(width*ratio));canvas.height=Math.max(1,Math.floor(height*ratio));ctx.drawImage(source,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);return jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'});};
  camera.addEventListener('click',async()=>{
    if(camera.disabled)return;camera.disabled=true;stopCamera();
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('当前设备无法开启相机，可从相册选择二维码');
      if(isNative)await requestPermission('camera');if(ticket!==generation)return;
      const obtained=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:960},height:{ideal:720}}});
      if(ticket!==generation){obtained.getTracks().forEach(track=>track.stop());return;}stream=obtained;video.srcObject=stream;video.hidden=false;await video.play();note.textContent='请将朋友的小紫在个人二维码放入画面中。';
      const tick=()=>{if(ticket!==generation||!stream)return;try{const code=decode(video,video.videoWidth,video.videoHeight);if(code&&found(code.data))return;}catch{}scanTimer=setTimeout(tick,280);};tick();
    }catch(e){stopCamera();error(e.name==='NotAllowedError'?'相机权限未获允许，可从相册选择二维码':e.message||'暂时无法开启相机');}finally{if(ticket===generation)camera.disabled=false;}
  });
  album.addEventListener('click',()=>{stopCamera();video.hidden=true;input.value='';input.click();});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];if(!file||ticket!==generation)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>20*1024*1024){error('请选择不超过 20 MB 的 JPG、PNG 或 WebP 图片');return;}
    album.disabled=true;let url;
    try{url=URL.createObjectURL(file);const image=new Image();image.src=url;await image.decode();if(ticket!==generation)return;if(image.naturalWidth*image.naturalHeight>40e6)throw Error('图片尺寸过大，请先裁剪二维码区域');const code=decode(image,image.naturalWidth,image.naturalHeight);if(!code)throw Error('没有识别到二维码，请选择清晰的二维码图片');found(code.data);}
    catch(e){error(e.message||'无法读取这张图片');}finally{if(url)URL.revokeObjectURL(url);if(ticket===generation)album.disabled=false;}
  });
}
if(typeof window!=='undefined'){
  window.addEventListener('ichat-back',event=>{if(dialog?.open&&!event.defaultPrevented){event.preventDefault();closeQr();}},{capture:true});
  window.addEventListener('pagehide',closeQr);
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&stream){stopCamera();const video=dialog?.querySelector('video');if(video)video.hidden=true;}});
}
