import {isNative,messageAlert} from './native.js';
const defaults={banner:true,sound:true,vibration:true};
let audio,lastAlert=0;
export function readSettings(userId){try{const saved=JSON.parse(localStorage.getItem('ichat.reminders.'+userId)||'{}');return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof saved?.[key]==='boolean'?saved[key]:value]));}catch{return {...defaults};}}
export function writeSettings(userId,settings){localStorage.setItem('ichat.reminders.'+userId,JSON.stringify(settings));}
export function unlockAudio(){
  if(isNative)return;
  try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;audio??=new Audio();if(audio.state==='suspended')audio.resume().catch(()=>{});}catch{}
}
export async function play(settings,{test=false}={}){
  const now=Date.now();if(!test&&now-lastAlert<1500)return;lastAlert=now;
  if(isNative){try{await messageAlert({sound:settings.sound,vibration:settings.vibration});}catch{}return;}
  if(settings.vibration)try{navigator.vibrate?.(80);}catch{}
  if(!settings.sound||!audio||audio.state!=='running')return;
  try{const oscillator=audio.createOscillator(),gain=audio.createGain(),t=audio.currentTime;oscillator.frequency.setValueAtTime(740,t);gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.08,t+.015);gain.gain.exponentialRampToValueAtTime(.001,t+.17);oscillator.connect(gain);gain.connect(audio.destination);oscillator.start(t);oscillator.stop(t+.18);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}catch{}
}
export function shouldAlert(data,{userId,visible,activeId,page,chatVisible}){
  return !!data.message?.id&&data.message.senderId!==userId&&data.message.kind!=='system'&&!data.message.withdrawnAt&&!data.conversation?.muted&&visible&&!(chatVisible&&!page&&activeId===data.message.conversationId);
}
