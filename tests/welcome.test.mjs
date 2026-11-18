import test from 'node:test';
import assert from 'node:assert/strict';
import {createWelcome,WELCOME_SEEN_KEY} from '../web/assets/welcome.js';

class Element extends EventTarget{
  constructor(){super();this.attributes=new Map();this.dataset={};this.hidden=true;this.removed=false;}
  getAttribute(key){return this.attributes.get(key)??null;}
  setAttribute(key,value){this.attributes.set(key,value);}
  removeAttribute(key){this.attributes.delete(key);}
  remove(){this.removed=true;}
}
function fixture({query='',session=null,seen=false,readDenied=false,writeDenied=false,hidden=null}={}){
  const root=new Element(),screen=new Element(),image=new Element(),win=new EventTarget();
  if(hidden!==null)root.setAttribute('aria-hidden',hidden);
  let focusCalls=0;root.focus=()=>focusCalls++;
  screen.querySelector=selector=>selector==='img'?image:null;
  const values=new Map();if(session!==null)values.set('ichat.session',typeof session==='string'?session:JSON.stringify(session));
  if(seen)values.set(WELCOME_SEEN_KEY,'1');
  const storage={getItem(key){if(readDenied)throw Error('Storage denied');return values.get(key)??null;},setItem(key,value){if(writeDenied)throw Error('Storage quota');values.set(key,value);}};
  const timers=new Map();let next=0,now=0;
  Object.assign(win,{location:{search:query},performance:{now:()=>now},localStorage:storage,setTimeout(fn,delay){timers.set(++next,{fn,time:now+delay});return next;},clearTimeout(id){timers.delete(id);}});
  const doc={getElementById:id=>id==='app'?root:id==='brand-welcome'?screen:null};
  const controller=createWelcome({window:win,document:doc});
  function advance(ms){const target=now+ms;let item;while((item=[...timers].filter(([,t])=>t.time<=target).sort((a,b)=>a[1].time-b[1].time)[0])){const[id,t]=item;now=t.time;timers.delete(id);t.fn();}now=target;}
  return {root,screen,image,win,controller,values,timers,advance,focusCalls:()=>focusCalls};
}

test('first accountless entry exits immediately when the application becomes ready after the short presentation',()=>{
  const f=fixture();assert.equal(f.controller.shown,true);assert.equal(f.root.getAttribute('inert'),'');assert.equal(f.screen.hidden,false);
  f.advance(1000);assert.equal(f.screen.removed,false);assert.equal(f.values.has(WELCOME_SEEN_KEY),false);
  f.controller.ready();assert.equal(f.screen.removed,true);assert.equal(f.root.getAttribute('inert'),null);assert.equal(f.root.getAttribute('aria-hidden'),null);
  assert.equal(f.values.get(WELCOME_SEEN_KEY),'1');assert.equal(f.focusCalls(),0);assert.equal(f.timers.size,0);
});
test('a saved authenticated user does not get a welcome or lose input focus',()=>{
  const f=fixture({session:{token:'existing-session',user:{id:'owner'}}});
  assert.equal(f.controller.shown,false);assert.equal(f.controller.reason,'authenticated');assert.equal(f.root.getAttribute('inert'),null);
  f.controller.ready();assert.equal(f.focusCalls(),0);assert.equal(f.values.has(WELCOME_SEEN_KEY),false);assert.equal(f.timers.size,0);
});
test('a completed first-entry flag skips the welcome on later accountless launches',()=>{
  const f=fixture({seen:true});assert.equal(f.controller.shown,false);assert.equal(f.controller.reason,'already-seen');assert.equal(f.timers.size,0);
});
test('demo and embedded showcase pages always skip presentation, including preview requests',()=>{
  for(const query of ['?demo=lin','?demo=chen&welcome=preview','?embed=1']){
    const f=fixture({query});assert.equal(f.controller.shown,false);assert.equal(f.controller.reason,'demo');assert.equal(f.root.getAttribute('inert'),null);
  }
});
test('fast application readiness waits only for 900ms since presentation began without a click or focus change',()=>{
  const f=fixture();f.advance(150);f.controller.ready();f.advance(749);assert.equal(f.controller.shown,true);assert.equal(f.values.has(WELCOME_SEEN_KEY),false);
  f.advance(1);assert.equal(f.controller.shown,false);assert.equal(f.values.get(WELCOME_SEEN_KEY),'1');assert.equal(f.focusCalls(),0);
});
test('a loading error removes the welcome so the existing boot failure view is not hidden',()=>{
  const f=fixture({hidden:'false'});const event=Object.assign(new Event('error'),{message:'Module load failed'});f.win.dispatchEvent(event);
  assert.equal(f.screen.removed,true);assert.equal(f.root.getAttribute('aria-hidden'),'false');assert.equal(f.root.getAttribute('inert'),null);
  f.controller.ready();f.advance(20000);assert.equal(f.values.has(WELCOME_SEEN_KEY),false);assert.equal(f.timers.size,0);
});
test('a startup that never reaches ready cannot leave a permanent welcome overlay',()=>{
  const f=fixture();f.advance(10000);assert.equal(f.controller.shown,false);assert.equal(f.values.has(WELCOME_SEEN_KEY),false);assert.equal(f.root.getAttribute('inert'),null);
});
test('image failure and rejected application initialization both release the underlying UI',()=>{
  const image=fixture();image.image.dispatchEvent(new Event('error'));assert.equal(image.controller.shown,false);assert.equal(image.values.has(WELCOME_SEEN_KEY),false);
  const rejected=fixture();rejected.win.dispatchEvent(new Event('unhandledrejection'));assert.equal(rejected.controller.shown,false);assert.equal(rejected.root.getAttribute('inert'),null);
});
test('blocked storage skips presentation and write failures do not prevent entering the application',()=>{
  const read=fixture({readDenied:true});assert.equal(read.controller.reason,'storage-unavailable');assert.equal(read.controller.shown,false);
  const write=fixture({writeDenied:true});write.controller.ready();assert.doesNotThrow(()=>write.advance(900));assert.equal(write.controller.shown,false);
});
test('a malformed session cache is not treated as an authenticated session',()=>{
  const f=fixture({session:'broken-json'});assert.equal(f.controller.shown,true);f.controller.ready();f.advance(900);assert.equal(f.values.get(WELCOME_SEEN_KEY),'1');
});
test('preview holds its visual presentation without changing authentication or the first-entry flag',()=>{
  const saved={token:'original-token',user:{id:'original-user'}},f=fixture({query:'?welcome=preview',session:saved,seen:true});
  assert.equal(f.controller.reason,'preview');f.controller.ready();f.advance(60000);assert.equal(f.controller.shown,true);
  assert.equal(f.screen.querySelector('button'),null);f.controller.destroy();assert.equal(f.controller.shown,false);assert.equal(f.values.get('ichat.session'),JSON.stringify(saved));assert.equal(f.values.get(WELCOME_SEEN_KEY),'1');
  const fresh=fixture({query:'?welcome=preview'});fresh.controller.ready();fresh.controller.destroy();assert.equal(fresh.values.has(WELCOME_SEEN_KEY),false);
});
test('repeated ready signals do not extend the display and destroying cleans up without marking completed',()=>{
  const f=fixture();f.controller.ready();f.advance(400);f.controller.ready();f.advance(500);assert.equal(f.controller.shown,false);
  const gone=fixture();gone.controller.destroy();gone.advance(20000);assert.equal(gone.timers.size,0);assert.equal(gone.values.has(WELCOME_SEEN_KEY),false);
});
