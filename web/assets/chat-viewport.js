// Keep the reading position across keyboard/composer resizes. Only follow the
// bottom when the reader was already there, or after they send a message.
export function attachChatViewport({shell,messages,input,sendButton=null,window:win=window}){
  let height=messages.clientHeight,top=messages.scrollTop;
  let following=atBottom(),frame=0,disposed=false;
  const viewport=win.visualViewport;
  function atBottom(){return messages.scrollHeight-messages.clientHeight-messages.scrollTop<140;}
  function pin(){messages.scrollTop=messages.scrollHeight;top=messages.scrollTop;}
  function rememberPosition(){height=messages.clientHeight;top=messages.scrollTop;following=atBottom();}
  function resized(){
    if(disposed)return;
    if(!messages.isConnected){destroy();return;}
    const nextHeight=messages.clientHeight;
    if(nextHeight===height)return;
    height=nextHeight;
    if(following)pin();
    else{messages.scrollTop=top;top=messages.scrollTop;}
  }
  function update(){
    frame=0;if(disposed)return;
    if(!messages.isConnected){destroy();return;}
    const phone=win.document.documentElement.classList.contains('native-phone')||win.matchMedia('(max-width:700px)').matches;
    // Ignore pinch zoom: shrinking the whole app while magnifying would fight
    // the user's zoom. WebView resize and browser visual-only resize both work.
    if(phone&&(!viewport||Math.abs(viewport.scale-1)<.02)){
      const visible=Math.min(win.innerHeight,viewport?.height||win.innerHeight);
      if(visible>0)shell.style.setProperty('--chat-height',Math.round(visible)+'px');
    }else shell.style.removeProperty('--chat-height');
    resized();
  }
  function schedule(){if(!disposed&&!frame)frame=win.requestAnimationFrame(update);}
  function scrolled(){
    // A layout-induced scroll event must not turn off following just because
    // the keyboard made the viewport shorter before ResizeObserver ran.
    if(messages.clientHeight!==height){resized();return;}
    top=messages.scrollTop;following=atBottom();
  }
  function focused(){if(messages.clientHeight===height)rememberPosition();schedule();}
  function mediaLoaded(){if(following)pin();}
  function keepComposerFocus(event){
    // Preserve an existing editing session before the send button can take
    // focus. Never refocus after a response: the user may have dismissed the
    // keyboard, opened a dialog, or switched chats while the send was pending.
    if(event.button===0&&event.isPrimary!==false&&win.document.activeElement===input&&!input.disabled&&!input.readOnly)event.preventDefault();
  }
  const observer=win.ResizeObserver?new win.ResizeObserver(resized):null;
  observer?.observe(messages);
  messages.addEventListener('scroll',scrolled,{passive:true});
  messages.addEventListener('load',mediaLoaded,true);
  input.addEventListener('focus',focused);
  sendButton?.addEventListener('pointerdown',keepComposerFocus);
  sendButton?.addEventListener('mousedown',keepComposerFocus);
  win.addEventListener('resize',schedule,{passive:true});
  viewport?.addEventListener('resize',schedule,{passive:true});
  viewport?.addEventListener('scroll',schedule,{passive:true});
  function destroy(){
    if(disposed)return;disposed=true;observer?.disconnect();
    if(frame)win.cancelAnimationFrame(frame);
    messages.removeEventListener('scroll',scrolled);
    messages.removeEventListener('load',mediaLoaded,true);
    input.removeEventListener('focus',focused);
    sendButton?.removeEventListener('pointerdown',keepComposerFocus);
    sendButton?.removeEventListener('mousedown',keepComposerFocus);
    win.removeEventListener('resize',schedule);
    viewport?.removeEventListener('resize',schedule);
    viewport?.removeEventListener('scroll',schedule);
    shell.style.removeProperty('--chat-height');
  }
  update();
  return {destroy,rememberPosition,followLatest(){if(!disposed){following=true;height=messages.clientHeight;pin();}}};
}
