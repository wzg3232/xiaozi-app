export const WELCOME_SEEN_KEY='xiaozi.welcome.seen.v1';

// The welcome is a local first-entry presentation, never an authentication gate.
// No network, image decode or font loading is awaited to enter the application.
export function createWelcome({window:win=window,document:doc=win.document,minDurationMs=900,maxWaitMs=10000}={}){
  const screen=doc.getElementById('brand-welcome'),root=doc.getElementById('app');
  const noop={shown:false,reason:'unavailable',ready(){},fail(){},destroy(){}};
  if(!screen||!root)return noop;
  const query=new URLSearchParams(win.location.search);
  const preview=query.get('welcome')==='preview';
  let storage,seen,saved,reason;
  try{
    storage=win.localStorage;seen=storage.getItem(WELCOME_SEEN_KEY);
    try{saved=JSON.parse(storage.getItem('ichat.session')||'null');}catch{}
  }catch{reason='storage-unavailable';}
  if(query.has('demo')||query.get('embed')==='1')reason='demo';
  else if(!reason&&!preview&&saved?.token&&saved?.user)reason='authenticated';
  else if(!reason&&!preview&&seen==='1')reason='already-seen';
  if(reason){screen.remove();return {...noop,reason};}

  let visible=true,isReady=false,failed=false,exitTimer=0,guardTimer=0;
  const now=()=>win.performance?.now?.()??Date.now(),startedAt=now();
  const image=screen.querySelector('img');
  const previousInert=root.getAttribute('inert'),previousHidden=root.getAttribute('aria-hidden');
  root.setAttribute('inert','');root.setAttribute('aria-hidden','true');
  screen.hidden=false;screen.dataset.welcomeState='showing';
  if(preview)screen.dataset.welcomePreview='true';
  function restore(name,value){if(value===null)root.removeAttribute(name);else root.setAttribute(name,value);}
  function remember(){if(!preview&&!failed)try{storage.setItem(WELCOME_SEEN_KEY,'1');}catch{}}
  function clean(){
    win.clearTimeout(exitTimer);win.clearTimeout(guardTimer);
    image?.removeEventListener('error',fail);
    win.removeEventListener('error',onError,true);
    win.removeEventListener('unhandledrejection',fail);
  }
  function dismiss(markSeen=false){
    if(!visible)return;
    visible=false;clean();restore('inert',previousInert);restore('aria-hidden',previousHidden);screen.remove();
    if(markSeen)remember();
    // Do not focus any field here: dismissing a welcome must not summon a
    // keyboard, interrupt a session restoration, or steal another field's focus.
  }
  function fail(){failed=true;dismiss(false);}
  function onError(event){if(event.target?.tagName==='SCRIPT'||event.message)fail();}
  function ready(){
    if(isReady||failed)return;
    isReady=true;win.clearTimeout(guardTimer);
    if(!visible)return;
    screen.dataset.welcomeState='ready';
    if(!preview){
      const remaining=Math.max(0,minDurationMs-(now()-startedAt));
      if(remaining===0)dismiss(true);
      else exitTimer=win.setTimeout(()=>dismiss(true),remaining);
    }
  }
  image?.addEventListener('error',fail);
  win.addEventListener('error',onError,true);
  win.addEventListener('unhandledrejection',fail);
  if(!preview)guardTimer=win.setTimeout(fail,Math.max(0,maxWaitMs));
  return {get shown(){return visible;},reason:preview?'preview':'first-entry',ready,fail,destroy:fail};
}

// app.js imports this module first, so the welcome is mounted before the login
// module renders. A failed dependency load still leaves boot.js free to recover.
export const welcome=typeof window==='undefined'?null:createWelcome();
