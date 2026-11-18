import test from 'node:test';
import assert from 'node:assert/strict';
import {attachChatViewport} from '../web/assets/chat-viewport.js';

function fixture({top=1400,phone=true}={}){
  const messages=new EventTarget(),input=new EventTarget(),sendButton=new EventTarget(),win=new EventTarget(),viewport=new EventTarget();
  Object.assign(messages,{clientHeight:600,scrollHeight:2000,isConnected:true});
  let position=top;Object.defineProperty(messages,'scrollTop',{get:()=>position,set:value=>position=Math.max(0,Math.min(value,messages.scrollHeight-messages.clientHeight))});
  const properties=new Map(),frames=new Map();let sequence=0,observer;
  const shell={style:{setProperty(name,value){properties.set(name,value);messages.clientHeight=Number.parseInt(value)-200;},removeProperty(name){properties.delete(name);}}};
  Object.assign(viewport,{height:800,scale:1});
  Object.assign(win,{innerHeight:800,visualViewport:viewport,document:{documentElement:{classList:{contains:()=>phone}}},matchMedia:()=>({matches:phone}),requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),ResizeObserver:class{constructor(fn){observer=this;this.fn=fn;}observe(){}disconnect(){this.disconnected=true;}trigger(){if(!this.disconnected)this.fn();}}});
  const controller=attachChatViewport({shell,messages,input,sendButton,window:win});
  const flush=()=>{const list=[...frames.values()];frames.clear();for(const fn of list)fn();};
  const resize=(visible,{layout=true,scrollFirst=false}={})=>{
    viewport.height=visible;if(layout)win.innerHeight=visible;
    // Native layout may change before dispatching the window resize event.
    if(layout)messages.clientHeight=visible-200;
    if(scrollFirst)messages.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('resize'));win.dispatchEvent(new Event('resize'));flush();observer.trigger();
  };
  const scroll=position=>{messages.scrollTop=position;messages.dispatchEvent(new Event('scroll'));};
  const bottom=()=>assert.equal(messages.scrollTop,messages.scrollHeight-messages.clientHeight);
  return {controller,messages,input,sendButton,win,viewport,properties,frames,observer,flush,resize,scroll,bottom};
}

test('latest message follows the keyboard through animation and close, even when scroll fires before resize',()=>{
  const f=fixture();for(const height of [740,620,450,620,800,450,800]){f.resize(height,{scrollFirst:true});f.bottom();}f.controller.destroy();
});
test('reading older messages keeps its position through keyboard open/close and focus',()=>{
  const f=fixture({top:300});f.input.dispatchEvent(new Event('focus'));f.flush();f.resize(450);assert.equal(f.messages.scrollTop,300);f.resize(800);assert.equal(f.messages.scrollTop,300);f.controller.destroy();
});
test('user scrolling up stops following; returning to the bottom resumes it',()=>{
  const f=fixture();f.scroll(400);f.resize(450);assert.equal(f.messages.scrollTop,400);f.scroll(f.messages.scrollHeight);f.resize(800);f.bottom();f.controller.destroy();
});
test('browsers that only resize the visual viewport keep the composer above the keyboard',()=>{
  const f=fixture();f.resize(440,{layout:false});assert.equal(f.win.innerHeight,800);assert.equal(f.properties.get('--chat-height'),'440px');assert.equal(f.messages.clientHeight,240);f.bottom();f.resize(800,{layout:false});f.bottom();f.controller.destroy();
});
test('reply composer resize follows latest but preserves a history reader',()=>{
  const f=fixture();f.messages.clientHeight-=70;f.observer.trigger();f.bottom();f.scroll(350);f.messages.clientHeight+=70;f.observer.trigger();assert.equal(f.messages.scrollTop,350);f.controller.destroy();
});
test('sending from history explicitly returns to latest and keeps following',()=>{
  const f=fixture({top:250});f.messages.scrollHeight+=110;f.controller.followLatest();f.bottom();f.resize(450);f.bottom();f.controller.destroy();
});
test('restored chat positions are not overridden by an initial observer notification',()=>{
  const f=fixture();f.messages.scrollTop=220;f.controller.rememberPosition();f.observer.trigger();f.resize(450);assert.equal(f.messages.scrollTop,220);f.controller.destroy();
});
test('pinch zoom is left to the browser instead of forcing a smaller app',()=>{
  const f=fixture();f.viewport.scale=2;f.viewport.height=400;f.viewport.dispatchEvent(new Event('resize'));f.flush();assert.equal(f.properties.has('--chat-height'),false);f.controller.destroy();
});
test('desktop layout has no mobile height override',()=>{
  const f=fixture({phone:false});assert.equal(f.properties.has('--chat-height'),false);f.resize(600);f.bottom();f.controller.destroy();
});
test('closing or replacing a chat removes observers, pending frames and viewport listeners',()=>{
  const f=fixture();f.viewport.dispatchEvent(new Event('resize'));assert.equal(f.frames.size,1);f.controller.destroy();assert.equal(f.frames.size,0);assert.equal(f.observer.disconnected,true);assert.equal(f.properties.has('--chat-height'),false);f.viewport.dispatchEvent(new Event('resize'));f.win.dispatchEvent(new Event('resize'));assert.equal(f.frames.size,0);
});

const press=(button,type='pointerdown',options={})=>{const event=Object.assign(new Event(type,{cancelable:true}),{button:0,isPrimary:true,...options});button.dispatchEvent(event);return event;};
test('primary touch, pen and mouse send presses keep an existing composer focus',()=>{
  const f=fixture();f.win.document.activeElement=f.input;
  for(const pointerType of ['touch','pen','mouse'])assert.equal(press(f.sendButton,'pointerdown',{pointerType}).defaultPrevented,true);
  assert.equal(press(f.sendButton,'mousedown').defaultPrevented,true);assert.equal(f.win.document.activeElement,f.input);f.controller.destroy();
});
test('sending does not reopen an unfocused composer or steal focus from another field',()=>{
  const f=fixture();for(const target of [null,{},f.sendButton]){f.win.document.activeElement=target;assert.equal(press(f.sendButton).defaultPrevented,false);assert.equal(f.win.document.activeElement,target);}f.controller.destroy();
});
test('secondary pointers, right click and unavailable input retain normal browser behavior',()=>{
  const f=fixture();f.win.document.activeElement=f.input;assert.equal(press(f.sendButton,'pointerdown',{button:2}).defaultPrevented,false);assert.equal(press(f.sendButton,'pointerdown',{isPrimary:false}).defaultPrevented,false);f.input.readOnly=true;assert.equal(press(f.sendButton).defaultPrevented,false);f.input.readOnly=false;f.input.disabled=true;assert.equal(press(f.sendButton).defaultPrevented,false);f.controller.destroy();
});
test('closing a chat also removes its send-button focus guard',()=>{
  const f=fixture();f.win.document.activeElement=f.input;f.controller.destroy();assert.equal(press(f.sendButton).defaultPrevented,false);assert.equal(press(f.sendButton,'mousedown').defaultPrevented,false);
});
