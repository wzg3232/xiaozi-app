package com.ichat.studio;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.net.URLEncoder;
import java.util.LinkedHashSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;

/** User-started, bounded cloud-data sync. No boot restart, wake locks or battery exemptions. */
public final class MessageNotificationService extends Service {
    public static final String START="com.ichat.studio.NOTIFICATIONS_START";
    private static final String STOP="com.ichat.studio.NOTIFICATIONS_STOP";
    private static final String ONGOING="ichat_sync",MESSAGES="ichat_messages",CALLS="ichat_calls";
    private static final int FOREGROUND_ID=6100,STATUS_ID=6101;
    private static final long MAX_RUN=5L*60*60*1000;
    private static volatile boolean running,starting;
    private static volatile long startTicket;
    private static volatile MessageNotificationService activeService;
    private volatile int generation;
    private volatile String token;
    private volatile HttpsURLConnection connection;
    private ScheduledExecutorService worker;
    private NotificationManager notifications;
    private long startedAt,cursor;
    private String since="",userId="";
    private boolean baseline=true;
    private int failures;
    private final LinkedHashSet<String> shown=new LinkedHashSet<>();
    private final Handler deadlineHandler=new Handler(Looper.getMainLooper());
    private Runnable deadline;

    static boolean isEnabled(){return running||starting;}
    static long markStarting(){starting=true;return ++startTicket;}
    static void clearStarting(){starting=false;startTicket++;}
    static void stop(Context context,boolean clear){starting=false;running=false;startTicket++;MessageNotificationService active=activeService;if(active!=null)active.stopCleanly();context.stopService(new Intent(context,MessageNotificationService.class));if(clear){NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);manager.cancelAll();}}
    @Override public void onCreate(){super.onCreate();activeService=this;notifications=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);createChannels();}
    @Override public IBinder onBind(Intent intent){return null;}
    private void createChannels(){if(Build.VERSION.SDK_INT>=26){notifications.createNotificationChannel(new NotificationChannel(ONGOING,"小紫在提醒状态",NotificationManager.IMPORTANCE_LOW));notifications.createNotificationChannel(new NotificationChannel(MESSAGES,"小紫在聊天消息",NotificationManager.IMPORTANCE_DEFAULT));notifications.createNotificationChannel(new NotificationChannel(CALLS,"小紫在通话邀请",NotificationManager.IMPORTANCE_HIGH));}}
    private boolean canNotify(){return (Build.VERSION.SDK_INT<33||checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)&&notifications.areNotificationsEnabled();}
    private int icon(){int id=getResources().getIdentifier("ic_notification","drawable",getPackageName());return id==0?android.R.drawable.stat_notify_chat:id;}
    private PendingIntent openApp(){return PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private Notification.Builder builder(String channel){return (Build.VERSION.SDK_INT>=26?new Notification.Builder(this,channel):new Notification.Builder(this)).setColor(0xff7b1989);}
    private Notification ongoing(){
        Intent off=new Intent(this,MessageNotificationService.class).setAction(STOP);PendingIntent stop=PendingIntent.getService(this,1,off,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return builder(ONGOING).setSmallIcon(icon()).setContentTitle("小紫在持续消息提醒已开启").setContentText("定期同步消息提醒 · 本次最长 5 小时 · 点此返回应用").setContentIntent(openApp()).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE).addAction(new Notification.Action.Builder(null,"关闭提醒",stop).build()).build();
    }
    @Override public synchronized int onStartCommand(Intent intent,int flags,int startId){
        if(intent==null||STOP.equals(intent.getAction())){stopCleanly();return START_NOT_STICKY;}
        if(intent.getLongExtra("startTicket",-1)!=startTicket||!starting){if(!running)stopCleanly();return START_NOT_STICKY;}
        String supplied=intent.getStringExtra("token");
        if(!START.equals(intent.getAction())||supplied==null||!supplied.matches("[A-Za-z0-9_-]{32,200}")||!canNotify()){stopCleanly();return START_NOT_STICKY;}
        try{
            if(Build.VERSION.SDK_INT>=29)startForeground(FOREGROUND_ID,ongoing(),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);else startForeground(FOREGROUND_ID,ongoing());
        }catch(Exception error){postStatus("系统暂停了持续提醒，请打开小紫在后重新开启");stopCleanly();return START_NOT_STICKY;}
        final int run=++generation;if(worker!=null)worker.shutdownNow();HttpsURLConnection previous=connection;if(previous!=null)closeAsync(previous);
        token=supplied;running=true;starting=false;cursor=0;since="";userId="";baseline=true;failures=0;shown.clear();startedAt=SystemClock.elapsedRealtime();
        if(deadline!=null)deadlineHandler.removeCallbacks(deadline);deadline=()->finishRun(run,"本次持续提醒已结束，请打开小紫在手动重新开启");deadlineHandler.postDelayed(deadline,MAX_RUN);
        worker=Executors.newSingleThreadScheduledExecutor();worker.execute(()->poll(run));
        return START_NOT_STICKY;
    }
    private void poll(final int run){
        String credential=token;if(!running||credential==null||run!=generation)return;
        if(SystemClock.elapsedRealtime()-startedAt>=MAX_RUN){finishRun(run,"本次持续提醒已结束，请打开小紫在手动重新开启");return;}
        if(!canNotify()){finishRun(run,null);return;}
        long next=15000;
        try{
            if(userId.isEmpty()){JSONObject self=fetchObject("/api/me",credential,run);if(self==null)return;JSONObject user=self.optJSONObject("user");String id=user==null?"":user.optString("id","");if(id.isEmpty())throw new Exception();synchronized(this){if(run!=generation)return;userId=id;}}
            String query=baseline?"":"?after="+cursor+"&since="+URLEncoder.encode(since,"UTF-8");
            JSONObject response=fetchObject("/api/notifications"+query,credential,run);if(response==null)return;long newCursor=response.optLong("cursor",-1);String serverTime=response.optString("serverTime","");if(newCursor<0||serverTime.length()<10||serverTime.length()>50)throw new Exception();
            JSONArray items=response.optJSONArray("notifications");if(!baseline&&items!=null)for(int i=0;i<Math.min(items.length(),50);i++){JSONObject item=items.optJSONObject(i);if(item!=null)postMessage(run,item);}
            JSONObject call=response.optJSONObject("call"),callee=call==null?null:call.optJSONObject("callee");if(call!=null&&callee!=null&&userId.equals(callee.optString("id"))&&"ringing".equals(call.optString("state"))){JSONObject caller=call.optJSONObject("caller");postMessage(run,NativeActions.object("id","call:"+call.optString("id"),"kind","call","title",caller==null?"小紫在来电":caller.optString("displayName","小紫在来电"),"body","有人邀请你通话，点此打开小紫在"));}
            synchronized(this){if(run!=generation)return;cursor=newCursor;since=serverTime;baseline=false;failures=0;}
        }catch(Exception error){synchronized(this){if(run!=generation)return;failures=Math.min(failures+1,5);next=Math.min(300000,15000L*(1L<<failures));}}
        ScheduledExecutorService current=worker;if(running&&run==generation&&credential.equals(token)&&current!=null&&!current.isShutdown())try{current.schedule(()->poll(run),next,TimeUnit.MILLISECONDS);}catch(Exception ignored){}
    }
    private JSONObject fetchObject(String path,String credential,int run)throws Exception {
        HttpsURLConnection request=(HttpsURLConnection)new URL(NativeActions.SERVER+path).openConnection();
        try{
            synchronized(this){if(!running||run!=generation)return null;connection=request;}
            request.setInstanceFollowRedirects(false);request.setConnectTimeout(10000);request.setReadTimeout(15000);request.setRequestProperty("Authorization","Bearer "+credential);
            int status=request.getResponseCode();if(status==401){finishRun(run,"登录已过期，请打开小紫在重新登录后开启提醒");return null;}if(status!=200)throw new Exception();
            ByteArrayOutputStream data=new ByteArrayOutputStream();try(InputStream input=request.getInputStream()){byte[] bytes=new byte[8192];int count;while((count=input.read(bytes))!=-1){if(!running||run!=generation||!credential.equals(token))return null;if(data.size()+count>768*1024)throw new Exception();data.write(bytes,0,count);}}
            if(!running||run!=generation||!credential.equals(token))return null;return new JSONObject(data.toString("UTF-8"));
        }finally{request.disconnect();if(connection==request)connection=null;}
    }
    private String shortText(String text,int max){return text.length()>max?text.substring(0,max):text;}
    private synchronized void postMessage(int run,JSONObject item){
        if(!running||run!=generation||!canNotify())return;String id=item.optString("id","");if(id.isEmpty()||shown.contains(id))return;shown.add(id);if(shown.size()>256)shown.remove(shown.iterator().next());
        // The foreground page already displays a banner and handles sound/vibration.
        if(MainActivity.isInForeground())return;
        boolean call="call".equals(item.optString("kind"));String title=shortText(item.optString("title","小紫在"),100),body=shortText(item.optString("body","有新的消息"),180);
        Notification publicVersion=builder(call?CALLS:MESSAGES).setSmallIcon(icon()).setContentTitle("小紫在有新的消息").setContentText("解锁后查看").build();
        Notification message=builder(call?CALLS:MESSAGES).setSmallIcon(icon()).setContentTitle(title).setContentText(body).setContentIntent(openApp()).setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).setCategory(call?Notification.CATEGORY_CALL:Notification.CATEGORY_MESSAGE).build();
        try{notifications.notify(10000+(id.hashCode()&0x3fffffff),message);}catch(SecurityException ignored){}
    }
    private void postStatus(String body){if(notifications==null||!canNotify())return;try{notifications.notify(STATUS_ID,builder(ONGOING).setSmallIcon(icon()).setContentTitle("小紫在持续提醒已暂停").setContentText(body).setContentIntent(openApp()).setAutoCancel(true).build());}catch(SecurityException ignored){}}
    private synchronized void finishRun(int run,String message){if(run!=generation)return;if(message!=null)postStatus(message);stopCleanly();}
    private static void closeAsync(HttpsURLConnection request){Thread close=new Thread(request::disconnect,"iChat-close-sync");close.setDaemon(true);close.start();}
    private synchronized void stopCleanly(){generation++;running=false;starting=false;token=null;userId="";if(deadline!=null){deadlineHandler.removeCallbacks(deadline);deadline=null;}HttpsURLConnection request=connection;connection=null;if(request!=null)closeAsync(request);if(worker!=null){worker.shutdownNow();worker=null;}shown.clear();stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
    @Override public void onTimeout(int startId,int type){postStatus("已达到系统允许的后台运行时限，请打开应用后手动开启");stopCleanly();}
    @Override public void onDestroy(){stopCleanly();if(activeService==this)activeService=null;super.onDestroy();}
}
