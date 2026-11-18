(function () {
  // Native clients always use the phone layout, including wide emulator viewports.
  if (window.iChatNative && typeof window.iChatNative.postMessage === 'function')
    document.documentElement.classList.add('native-phone');
  function explain(message) {
    var root = document.getElementById('app');
    if (!root || !root.querySelector('.boot')) return;
    var panel = document.createElement('div');
    panel.className = 'boot';
    var title = document.createElement('p');
    title.textContent = '小紫在 界面未能加载';
    var detail = document.createElement('p');
    detail.textContent = message;
    var retry = document.createElement('button');
    retry.className = 'button';
    retry.textContent = '重新打开';
    retry.onclick = function () { window.location.reload(); };
    panel.appendChild(title); panel.appendChild(detail); panel.appendChild(retry);
    root.textContent = ''; root.appendChild(panel);
  }
  window.addEventListener('error', function (event) {
    if (event.target && event.target.tagName === 'SCRIPT')
      explain('界面文件读取失败，请安装最新版本。');
    else if (event.message) explain('启动发生错误，请安装最新版本后重试。');
  }, true);
  setTimeout(function () { explain('请重新打开应用；仍无法启动时请更新系统 WebView。'); }, 10000);
}());
