package com.ichat.studio;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceError;
import android.webkit.PermissionRequest;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Locale;

/** Bundled UI with explicit, user-controlled access to native capabilities. */
public final class MainActivity extends Activity {
    private static volatile boolean foreground;
    static boolean isInForeground(){return foreground;}
    private WebView web;
    private NativeActions actions;
    private Object systemBackCallback;
    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        getWindow().setStatusBarColor(Color.rgb(250,247,253));
        getWindow().setNavigationBarColor(Color.rgb(250,247,253));
        int flags=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if(Build.VERSION.SDK_INT>=26) flags|=View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);
        final FrameLayout container=new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(250,247,253));
        web=new WebView(this);
        web.setBackgroundColor(Color.rgb(250,247,253));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setUseWideViewPort(true);
        web.getSettings().setLoadWithOverviewMode(false);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        actions=new NativeActions(this,web);
        web.addJavascriptInterface(actions,"iChatNative");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("iChatWeb",message.message()+" at "+message.sourceId()+":"+message.lineNumber());
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                return actions!=null&&actions.showFileChooser(view,callback,params);
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                if(actions==null) request.deny(); else actions.onWebPermissionRequest(request);
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if(actions!=null) actions.onWebPermissionCancelled(request);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) {
                if(actions!=null) actions.pageChanged();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                Uri uri=request.getUrl();
                if(!NativeActions.isLocalOrigin(uri)) return null;
                String file=uri.getPath();
                if(file==null||"/".equals(file)) file="/index.html";
                if(file.contains("..")||file.contains("\\")||file.indexOf('\0')>=0) return missing();
                try {
                    String lower=file.toLowerCase(Locale.ROOT);
                    String mime=lower.endsWith(".html")?"text/html":lower.endsWith(".js")?"text/javascript":lower.endsWith(".css")?"text/css":lower.endsWith(".svg")?"image/svg+xml":lower.endsWith(".png")?"image/png":lower.endsWith(".jpg")||lower.endsWith(".jpeg")?"image/jpeg":lower.endsWith(".ttf")?"font/ttf":lower.endsWith(".json")?"application/json":"application/octet-stream";
                    HashMap<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-cache");
                    // JavascriptInterface is exposed to frames too: disallow frames and external scripts.
                    headers.put("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' https: wss: http: ws:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'");
                    return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(file.substring(1)));
                } catch(Exception error) {Log.e("iChatAssets","Cannot open "+file,error);return missing();}
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error) {
                Log.e("iChatWeb","Load failed: "+request.getUrl()+" "+error.getDescription());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                return !NativeActions.isLocalOrigin(request.getUrl());
            }
        });
        container.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        container.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View view,WindowInsets insets) {
                view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });
        setContentView(container);
        if(Build.VERSION.SDK_INT>=33)systemBackCallback=BackApi33.install(this);
        if(savedState==null||web.restoreState(savedState)==null||!NativeActions.isLocalPage(web.getUrl())) web.loadUrl("http://localhost/index.html?native=1");
    }
    private WebResourceResponse missing() {
        return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",java.util.Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    }
    @Override protected void onResume(){super.onResume();foreground=true;if(actions!=null)actions.onResume();}
    @Override protected void onPause(){foreground=false;if(actions!=null)actions.onPause();super.onPause();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(actions!=null)actions.onActivityResult(request,result,data);}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(actions!=null)actions.onRequestPermissionsResult(request,permissions,results);}
    @Override public void onBackPressed() {
        if(web==null) {moveTaskToBack(true);return;}
        web.evaluateJavascript("(function(){var e=new CustomEvent('ichat-back',{cancelable:true});if(!window.dispatchEvent(e)||e.defaultPrevented)return true;var ds=document.querySelectorAll('dialog[open]');if(ds.length){ds[ds.length-1].close();return true;}var s=document.querySelector('.app-shell.chat-open');var b=document.querySelector('[data-action=back]');if(s&&b&&b.getClientRects().length){b.click();return true;}return false;})()",new ValueCallback<String>() {
            @Override public void onReceiveValue(String handled) {if(web!=null&&!isFinishing()&&!"true".equals(handled))moveTaskToBack(true);}
        });
    }
    @Override public void onSaveInstanceState(Bundle state){super.onSaveInstanceState(state);if(web!=null)web.saveState(state);}
    @Override public void onDestroy(){if(Build.VERSION.SDK_INT>=33&&systemBackCallback!=null)BackApi33.remove(this,systemBackCallback);if(actions!=null){actions.destroy();actions=null;}if(web!=null){web.removeJavascriptInterface("iChatNative");web.destroy();web=null;}super.onDestroy();}
    private static final class BackApi33 {
        static Object install(MainActivity activity){android.window.OnBackInvokedCallback callback=activity::onBackPressed;activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,callback);return callback;}
        static void remove(Activity activity,Object callback){activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback)callback);}
    }
}
