package com.ichat.studio;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.ContactsContract;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

/** All privileged actions are bounded and entered from the bundled, frame-free UI. */
public final class NativeActions {
    static final String SERVER="https://chat.pvdust.com";
    private final Activity activity;
    private final WebView web;
    private final Handler ui=new Handler(Looper.getMainLooper());
    private final ExecutorService io=new ThreadPoolExecutor(1,2,30,TimeUnit.SECONDS,new ArrayBlockingQueue<Runnable>(4));
    private final HashSet<String> requests=new HashSet<>();
    private final HashMap<String,Reply> replies=new HashMap<>();
    private final ArrayList<Runnable> resumeTasks=new ArrayList<>();
    private volatile int pageEpoch;
    private boolean destroyed,resumed;
    private volatile int authenticationEpoch;
    private int locationGeneration;
    private static int nextRequest=0x4100;
    private Runnable permissionDone;
    private boolean notificationPermissionPending;
    private int permissionRequest=-1,permissionEpoch;
    private PermissionRequest webPermission;
    private ValueCallback<Uri[]> fileCallback;
    private int fileRequest=-1,fileEpoch;
    private boolean imageOnly,multipleFiles;
    private Uri cameraUri;
    private File cameraFile;
    private AlertDialog pickerDialog,actionDialog;
    private Reply contactReply,locationReply,actionReply;
    private volatile Reply downloadReply;
    private int contactRequest=-1,downloadRequest=-1;
    private String downloadToken,downloadId,downloadName;
    private File downloadCache;
    private volatile DocumentGrant downloadGrant;
    private volatile HttpsURLConnection downloadConnection;
    private volatile boolean downloadCancelled;
    private volatile int downloadGeneration;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private CancellationSignal locationCancel;
    private Runnable locationTimeout;
    private long lastMessageAlert;

    NativeActions(Activity activity,WebView web){this.activity=activity;this.web=web;clearOldDownloadCache();}
    static boolean isLocalOrigin(Uri uri){return uri!=null&&"http".equals(uri.getScheme())&&"localhost".equals(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==80)&&uri.getUserInfo()==null;}
    static boolean isLocalPage(String value){try{Uri uri=Uri.parse(value);return isLocalOrigin(uri)&&("/index.html".equals(uri.getPath())||"/".equals(uri.getPath()));}catch(Exception error){return false;}}
    private boolean valid(){return !destroyed&&!activity.isFinishing()&&!activity.isDestroyed()&&isLocalPage(web.getUrl());}
    private int requestCode(){int value=nextRequest++;if(nextRequest>0x7ffe)nextRequest=0x4100;return value;}
    static JSONObject object(Object... pairs){JSONObject result=new JSONObject();try{for(int i=0;i<pairs.length;i+=2)result.put(String.valueOf(pairs[i]),pairs[i+1]);}catch(Exception ignored){}return result;}
    private interface Reply {void finish(JSONObject data,String error);}
    private Reply replyFor(final String id,final int epoch,final boolean sessionNeutral){final AtomicBoolean finished=new AtomicBoolean();final int auth=authenticationEpoch;return (data,error)->{if(!finished.compareAndSet(false,true))return;ui.post(()->{
        if(epoch!=pageEpoch||!valid())return;requests.remove(id);replies.remove(id);
        String failure=error;JSONObject answer=data;
        if(!sessionNeutral&&auth!=authenticationEpoch){failure="登录状态已变化，请重新操作";answer=null;}
        JSONObject result=object("id",id,"ok",failure==null,"data",answer==null?JSONObject.NULL:answer,"error",failure==null?JSONObject.NULL:failure);
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('ichat-native-result',{detail:"+result.toString()+"}));",null);
    });};}
    private void afterResume(Runnable task){if(resumed)task.run();else if(!destroyed)resumeTasks.add(task);}
    void onResume(){resumed=true;ArrayList<Runnable> tasks=new ArrayList<>(resumeTasks);resumeTasks.clear();for(Runnable task:tasks)task.run();}
    void onPause(){resumed=false;if(locationReply!=null)finishLocation(null,"应用已退到后台，本次定位已取消");}
    void pageChanged(){pageEpoch++;requests.clear();replies.clear();resumeTasks.clear();cancelFileChooser(true);cancelNativePickers();cancelPermissions();finishLocation(null,null);activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);}
    void destroy(){destroyed=true;pageChanged();ui.removeCallbacksAndMessages(null);io.shutdownNow();}

    @JavascriptInterface public void postMessage(String message){
        if(message==null||message.length()>8192)return;final int epoch=pageEpoch;
        ui.post(()->{
            if(epoch!=pageEpoch||!valid())return;
            String id="";Reply reply=null;
            try{
                JSONObject input=new JSONObject(message);id=input.optString("id","");
                if(!id.matches("[A-Za-z0-9_.:-]{1,80}"))return;
                String action=input.optString("action","");reply=replyFor(id,epoch,"stopNotifications".equals(action));
                if(requests.contains(id))return;if(requests.size()>=16){reply.finish(null,"当前操作过多，请完成后再试");return;}
                requests.add(id);replies.put(id,reply);
                JSONObject payload=input.optJSONObject("payload");if(payload==null)payload=new JSONObject();
                if("getPermissionState".equals(action)){reply.finish(permissionState(),null);return;}
                if("stopNotifications".equals(action)){authenticationEpoch++;for(Reply pending:new ArrayList<>(replies.values()))if(pending!=reply)pending.finish(null,"原生操作已取消，请重新操作");requests.clear();replies.clear();resumeTasks.clear();cancelPermissions();cancelFileChooser(true);cancelNativePickers();finishLocation(null,"已取消定位");MessageNotificationService.stop(activity,true);reply.finish(object("notificationsActive",false),null);return;}
                if("setCallActive".equals(action)){if(payload.optBoolean("active",false)&&resumed)activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);reply.finish(object("active",payload.optBoolean("active",false)&&resumed),null);return;}
                if(!resumed){reply.finish(null,"请回到小紫在前台再操作");return;}
                if("requestPermission".equals(action))requestNamedPermission(payload.optString("name",""),reply);
                else if("openSystemSettings".equals(action)){Intent settings=new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.fromParts("package",activity.getPackageName(),null));activity.startActivity(settings);reply.finish(object("opened",true),null);}
                else if("pickContact".equals(action))pickContact(reply);
                else if("getLocation".equals(action))explainLocation(reply);
                else if("downloadMedia".equals(action))downloadMedia(payload,reply);
                else if("startNotifications".equals(action))startNotifications(payload,reply);
                else if("messageAlert".equals(action))messageAlert(payload,reply);
                else reply.finish(null,"此原生操作暂不支持");
            }catch(Exception error){if(reply!=null)reply.finish(null,"系统操作暂时无法完成，请重试");}
        });
    }

    private void messageAlert(JSONObject payload,Reply reply){
        long now=android.os.SystemClock.elapsedRealtime();
        if(now-lastMessageAlert<1500){reply.finish(object("limited",true),null);return;}
        lastMessageAlert=now;
        boolean sound=payload.optBoolean("sound",false),vibration=payload.optBoolean("vibration",false);
        if(sound)try{
            android.media.ToneGenerator tone=new android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION,45);
            tone.startTone(android.media.ToneGenerator.TONE_PROP_BEEP,160);ui.postDelayed(tone::release,300);
        }catch(Exception ignored){}
        if(vibration)try{
            android.os.Vibrator vibrator=(android.os.Vibrator)activity.getSystemService(Activity.VIBRATOR_SERVICE);
            if(vibrator!=null&&vibrator.hasVibrator()){
                if(Build.VERSION.SDK_INT>=26)vibrator.vibrate(android.os.VibrationEffect.createOneShot(80,android.os.VibrationEffect.DEFAULT_AMPLITUDE),new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION).build());
                else vibrator.vibrate(80);
            }
        }catch(Exception ignored){}
        reply.finish(object("soundRequested",sound,"vibrationRequested",vibration),null);
    }
    private boolean granted(String permission){return activity.checkSelfPermission(permission)==PackageManager.PERMISSION_GRANTED;}
    private String status(String permission){if(granted(permission))return "granted";boolean asked=activity.getPreferences(0).getBoolean("asked:"+permission,false);return !asked?"prompt":activity.shouldShowRequestPermissionRationale(permission)?"denied":"blocked";}
    private boolean hasLocation(){return granted(Manifest.permission.ACCESS_COARSE_LOCATION)||granted(Manifest.permission.ACCESS_FINE_LOCATION);}
    private JSONObject permissionState(){
        NotificationManager manager=(NotificationManager)activity.getSystemService(Activity.NOTIFICATION_SERVICE);
        String notification=Build.VERSION.SDK_INT>=33?status(Manifest.permission.POST_NOTIFICATIONS):"granted";
        if("granted".equals(notification)&&!manager.areNotificationsEnabled())notification="blocked";
        return object("camera",activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)?status(Manifest.permission.CAMERA):"unsupported","microphone",activity.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE)?status(Manifest.permission.RECORD_AUDIO):"unsupported","notifications",notification,"location",hasLocation()?"granted":status(Manifest.permission.ACCESS_COARSE_LOCATION),"notificationsActive",MessageNotificationService.isEnabled());
    }
    private void requestNamedPermission(String name,Reply reply){
        if("unsupported".equals(permissionState().optString(name))){reply.finish(permissionState(),null);return;}
        String[] permissions;
        if("camera".equals(name))permissions=new String[]{Manifest.permission.CAMERA};
        else if("microphone".equals(name))permissions=new String[]{Manifest.permission.RECORD_AUDIO};
        else if("location".equals(name))permissions=new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION};
        else if("notifications".equals(name)){if(Build.VERSION.SDK_INT<33){reply.finish(permissionState(),null);return;}permissions=new String[]{Manifest.permission.POST_NOTIFICATIONS};}
        else{reply.finish(null,"请选择相机、麦克风、通知或定位权限");return;}
        requestPermissions(permissions,()->reply.finish(permissionState(),null),reply);
    }
    private void requestPermissions(String[] permissions,Runnable done,Reply failure){
        ArrayList<String> missing=new ArrayList<>();for(String permission:permissions)if(!granted(permission))missing.add(permission);
        if(missing.isEmpty()){done.run();return;}
        // Android 12+ requires coarse and fine to be requested together, including upgrades.
        if(missing.contains(Manifest.permission.ACCESS_FINE_LOCATION)&&!missing.contains(Manifest.permission.ACCESS_COARSE_LOCATION))for(String permission:permissions)if(Manifest.permission.ACCESS_COARSE_LOCATION.equals(permission)){missing.add(permission);break;}
        if(permissionDone!=null){failure.finish(null,"请先完成当前系统权限申请");return;}
        if(!valid()||!resumed){failure.finish(null,"请回到小紫在前台再申请权限");return;}
        permissionDone=done;permissionEpoch=pageEpoch;permissionRequest=requestCode();
        android.content.SharedPreferences.Editor prefs=activity.getPreferences(0).edit();for(String permission:missing)prefs.putBoolean("asked:"+permission,true);prefs.apply();
        try{activity.requestPermissions(missing.toArray(new String[0]),permissionRequest);}catch(Exception error){permissionDone=null;permissionRequest=-1;failure.finish(null,"系统无法显示权限申请，请前往应用设置");}
    }
    void onRequestPermissionsResult(int request,String[] permissions,int[] results){
        if(request!=permissionRequest)return;Runnable done=permissionDone;int epoch=permissionEpoch;permissionDone=null;permissionRequest=-1;
        if(done!=null&&epoch==pageEpoch&&valid())afterResume(()->{if(epoch==pageEpoch&&valid())done.run();});
    }
    private void cancelPermissions(){permissionDone=null;permissionRequest=-1;notificationPermissionPending=false;if(webPermission!=null){webPermission.deny();webPermission=null;}}
    void onWebPermissionRequest(PermissionRequest request){
        if(!valid()||!resumed||!isLocalOrigin(request.getOrigin())){request.deny();return;}
        ArrayList<String> needed=new ArrayList<>();
        for(String resource:request.getResources()){
            if(PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource))needed.add(Manifest.permission.CAMERA);
            else if(PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource))needed.add(Manifest.permission.RECORD_AUDIO);
            else{request.deny();return;}
        }
        if(needed.isEmpty()||permissionDone!=null){request.deny();return;}
        if(webPermission!=null)webPermission.deny();webPermission=request;final int epoch=pageEpoch;
        Reply failure=(data,error)->{if(webPermission==request){webPermission=null;request.deny();}};
        requestPermissions(needed.toArray(new String[0]),()->{
            if(webPermission!=request)return;webPermission=null;
            boolean allowed=valid()&&resumed&&epoch==pageEpoch&&isLocalOrigin(request.getOrigin());for(String permission:needed)allowed=allowed&&granted(permission);
            if(allowed)request.grant(request.getResources());else request.deny();
        },failure);
    }
    void onWebPermissionCancelled(PermissionRequest request){if(webPermission==request)webPermission=null;}

    boolean showFileChooser(WebView view,ValueCallback<Uri[]> callback,WebChromeClient.FileChooserParams params){
        cancelFileChooser(true);
        if(view!=web||!valid()||!resumed||params==null||(params.getMode()!=WebChromeClient.FileChooserParams.MODE_OPEN&&params.getMode()!=WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)){callback.onReceiveValue(null);return true;}
        fileCallback=callback;fileRequest=requestCode();fileEpoch=pageEpoch;multipleFiles=params.getMode()==WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        imageOnly=true;boolean hasAccept=false;for(String accept:params.getAcceptTypes())for(String value:accept.split(",")){value=value.trim().toLowerCase(Locale.ROOT);if(!value.isEmpty()){hasAccept=true;if(!value.startsWith("image/"))imageOnly=false;}}imageOnly=imageOnly&&hasAccept;
        final int request=fileRequest;
        if(imageOnly){
            pickerDialog=new AlertDialog.Builder(activity).setTitle("发送照片").setItems(new String[]{"选择照片","拍照"},(dialog,which)->{pickerDialog=null;if(fileRequest==request){if(which==1)capturePhoto(request);else openDocument(request,true);}}).setOnCancelListener(dialog->{if(fileRequest==request)completeFileChooser(null);}).create();
            pickerDialog.show();
        }else openDocument(request,false);
        return true;
    }
    private void openDocument(int request,boolean photos){
        Intent picker=new Intent(Intent.ACTION_OPEN_DOCUMENT);picker.addCategory(Intent.CATEGORY_OPENABLE);picker.setType(photos?"image/*":"*/*");
        if(photos)picker.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/jpeg","image/png","image/webp"});
        picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,multipleFiles);picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try{activity.startActivityForResult(picker,request);}catch(ActivityNotFoundException|SecurityException error){completeFileChooser(null);toast("无法打开系统文件选择器，请安装文件或图库应用");}
    }
    private void capturePhoto(final int request){
        Reply failure=(data,error)->{if(fileRequest==request){completeFileChooser(null);toast(error);}};
        requestPermissions(new String[]{Manifest.permission.CAMERA},()->{
            if(fileRequest!=request||!valid())return;
            if(!granted(Manifest.permission.CAMERA)){completeFileChooser(null);toast("未允许相机权限，你仍可选择已有照片");return;}
            try{
                File folder=new File(activity.getCacheDir(),"camera-capture");if(!folder.exists()&&!folder.mkdir())throw new Exception();
                File[] previous=folder.listFiles();if(previous!=null)for(File file:previous)if(file.isFile()&&System.currentTimeMillis()-file.lastModified()>86400000L)file.delete();
                cameraFile=new File(folder,"capture-"+UUID.randomUUID()+".jpg");if(!cameraFile.createNewFile())throw new Exception();
                cameraUri=new Uri.Builder().scheme("content").authority(activity.getPackageName()+".camera").appendPath("capture").appendPath(cameraFile.getName()).build();
                Intent intent=new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,cameraUri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);intent.setClipData(ClipData.newRawUri("小紫在照片",cameraUri));
                activity.startActivityForResult(intent,request);
            }catch(Exception error){completeFileChooser(null);toast("无法打开相机，你仍可选择已有照片");}
        },failure);
    }
    private void completeFileChooser(Uri[] files){
        ValueCallback<Uri[]> callback=fileCallback;Uri captured=cameraUri;File capture=cameraFile;
        fileCallback=null;fileRequest=-1;cameraUri=null;cameraFile=null;imageOnly=false;multipleFiles=false;
        if(captured!=null)activity.revokeUriPermission(captured,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if(files==null&&capture!=null)capture.delete();
        if(callback!=null)callback.onReceiveValue(files);
    }
    private void cancelFileChooser(boolean close){int request=fileRequest;completeFileChooser(null);if(pickerDialog!=null){pickerDialog.dismiss();pickerDialog=null;}if(close&&request!=-1)activity.finishActivity(request);}
    private void toast(String message){if(message!=null&&!destroyed)Toast.makeText(activity,message,Toast.LENGTH_LONG).show();}
    private boolean readableSelection(Uri uri,boolean photos,Uri ownCapture){
        if(uri==null||!"content".equals(uri.getScheme())||uri.getAuthority()==null)return false;
        try{
            ProviderInfo provider=activity.getPackageManager().resolveContentProvider(uri.getAuthority(),0);
            if(provider!=null&&activity.getPackageName().equals(provider.packageName)&&!uri.equals(ownCapture))return false;
            try(Cursor info=activity.getContentResolver().query(uri,new String[]{OpenableColumns.SIZE},null,null,null)){
                if(info!=null&&info.moveToFirst()&&!info.isNull(0)&&info.getLong(0)>(photos?20L:10L)*1024*1024)return false;
            }
            String type=activity.getContentResolver().getType(uri);
            if(photos&&!"image/jpeg".equals(type)&&!"image/png".equals(type)&&!"image/webp".equals(type))return false;
            try(InputStream stream=activity.getContentResolver().openInputStream(uri)){
                if(stream==null)return false;if(!photos)return true;byte[] header=new byte[12];int used=0;
                while(used<header.length){int count=stream.read(header,used,header.length-used);if(count<=0)break;used+=count;}
                boolean jpeg=used>=3&&(header[0]&255)==255&&(header[1]&255)==216&&(header[2]&255)==255;
                boolean png=used>=8&&(header[0]&255)==137&&header[1]==80&&header[2]==78&&header[3]==71&&header[4]==13&&header[5]==10&&header[6]==26&&header[7]==10;
                boolean webp=used>=12&&header[0]==82&&header[1]==73&&header[2]==70&&header[3]==70&&header[8]==87&&header[9]==69&&header[10]==66&&header[11]==80;
                return ("image/jpeg".equals(type)&&jpeg)||("image/png".equals(type)&&png)||("image/webp".equals(type)&&webp);
            }
        }catch(Exception error){return false;}
    }
    void onActivityResult(int request,int result,Intent data){
        if(request==fileRequest&&fileCallback!=null){
            if(result!=Activity.RESULT_OK||!valid()||fileEpoch!=pageEpoch){completeFileChooser(null);return;}
            LinkedHashSet<Uri> selections=new LinkedHashSet<>();
            if(cameraUri!=null)selections.add(cameraUri);
            else if(data!=null){if(data.getData()!=null)selections.add(data.getData());ClipData items=data.getClipData();if(items!=null){if(items.getItemCount()>(multipleFiles?9:1)){completeFileChooser(null);toast("所选文件数量过多");return;}for(int i=0;i<items.getItemCount();i++)selections.add(items.getItemAt(i).getUri());}}
            if(selections.isEmpty()||selections.size()>(multipleFiles?9:1)){completeFileChooser(null);return;}
            final boolean photos=imageOnly;final Uri capture=cameraUri;final int epoch=fileEpoch;
            try{io.execute(()->{boolean accepted=true;for(Uri uri:selections)if(!readableSelection(uri,photos,capture)){accepted=false;break;}final boolean checked=accepted;ui.post(()->{if(fileRequest!=request||epoch!=pageEpoch)return;if(checked)completeFileChooser(selections.toArray(new Uri[0]));else{completeFileChooser(null);toast(photos?"请选择可读取的 JPEG、PNG 或 WebP 照片（20 MB 以内）":"文件不可读取或超过 10 MB，请重新选择");}});});}catch(Exception error){completeFileChooser(null);toast("系统正忙，请稍后重新选择");}
            return;
        }
        if(request==contactRequest&&contactReply!=null){Reply reply=contactReply;contactReply=null;contactRequest=-1;if(result!=Activity.RESULT_OK||data==null||data.getData()==null){reply.finish(null,"已取消联系人选择");return;}readContact(data.getData(),reply);return;}
        if(request==downloadRequest&&downloadReply!=null){downloadRequest=-1;if(result!=Activity.RESULT_OK||data==null||data.getData()==null){finishDownload(null,"已取消保存");return;}Log.i("iChatDownload","stage=picker-result grantFlags="+(data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION))+" persistable="+((data.getFlags()&Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)!=0));saveDownload(data.getData(),data.getFlags());}
    }
    private void pickContact(Reply reply){
        if(contactReply!=null){reply.finish(null,"请先完成当前联系人选择");return;}
        contactReply=reply;contactRequest=requestCode();
        try{activity.startActivityForResult(new Intent(Intent.ACTION_PICK).setType(ContactsContract.CommonDataKinds.Phone.CONTENT_TYPE),contactRequest);}catch(Exception error){contactReply=null;contactRequest=-1;reply.finish(null,"无法打开手机联系人选择器，你仍可手动输入手机号");}
    }
    private void readContact(Uri uri,Reply reply){
        if(!"content".equals(uri.getScheme())){reply.finish(null,"联系人格式不正确");return;}
        try{io.execute(()->{try(Cursor contact=activity.getContentResolver().query(uri,new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,ContactsContract.CommonDataKinds.Phone.NUMBER},null,null,null)){
            if(contact==null||!contact.moveToFirst())throw new Exception();String name=contact.getString(0),phone=contact.getString(1);
            if(phone==null||phone.trim().isEmpty())throw new Exception();phone=phone.replaceAll("[\\p{Cntrl}]","").trim();if(phone.length()>40)throw new Exception();if(name==null)name="";if(name.length()>120)name=name.substring(0,120);
            reply.finish(object("name",name,"phone",phone),null);
        }catch(Exception error){reply.finish(null,"无法读取所选号码，请直接输入手机号");}});}catch(Exception error){reply.finish(null,"系统正忙，请稍后再试");}
    }
    private void explainLocation(Reply reply){
        if(locationReply!=null||actionDialog!=null){reply.finish(null,"请先完成当前系统操作");return;}
        actionReply=reply;actionDialog=new AlertDialog.Builder(activity).setTitle("获取一次当前位置").setMessage("小紫在将请求本次位置，用于你接下来确认发送的位置卡片。不会持续跟踪位置，也不会在后台定位。").setNegativeButton("取消",(dialog,which)->{actionDialog=null;actionReply=null;reply.finish(null,"已取消定位");}).setPositiveButton("继续",(dialog,which)->{actionDialog=null;actionReply=null;
            if(hasLocation())beginLocation(reply);else requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION},()->{if(hasLocation())beginLocation(reply);else reply.finish(null,"未允许定位权限，你仍可正常聊天");},reply);
        }).setOnCancelListener(dialog->{actionDialog=null;actionReply=null;reply.finish(null,"已取消定位");}).create();actionDialog.show();
    }
    private void beginLocation(Reply reply){
        if(!valid()||!resumed){reply.finish(null,"请在小紫在前台获取位置");return;}
        locationManager=(LocationManager)activity.getSystemService(Activity.LOCATION_SERVICE);
        String provider=null;
        if(granted(Manifest.permission.ACCESS_FINE_LOCATION)&&providerEnabled(LocationManager.GPS_PROVIDER))provider=LocationManager.GPS_PROVIDER;
        else if(providerEnabled(LocationManager.NETWORK_PROVIDER))provider=LocationManager.NETWORK_PROVIDER;
        if(provider==null){reply.finish(null,"暂时无法获取位置，请检查手机定位服务和定位精度设置");return;}
        final int operation=++locationGeneration;locationReply=reply;locationTimeout=()->{if(operation==locationGeneration)finishLocation(null,"暂时无法获得位置，请检查定位服务或稍后重试");};ui.postDelayed(locationTimeout,22000);
        try{
            if(Build.VERSION.SDK_INT>=30){locationCancel=new CancellationSignal();locationManager.getCurrentLocation(provider,locationCancel,activity.getMainExecutor(),location->{if(operation!=locationGeneration)return;if(location==null)finishLocation(null,"暂时无法获得位置，请稍后重试");else finishLocation(location,null);});}
            else{locationListener=new LocationListener(){@Override public void onLocationChanged(Location location){if(operation==locationGeneration)finishLocation(location,null);}@Override public void onProviderDisabled(String provider){if(operation==locationGeneration)finishLocation(null,"手机定位服务已关闭");}@Override public void onProviderEnabled(String provider){}@Override public void onStatusChanged(String provider,int status,Bundle extras){}};locationManager.requestSingleUpdate(provider,locationListener,Looper.getMainLooper());}
        }catch(Exception error){finishLocation(null,"系统无法获取位置，请检查权限和定位设置");}
    }
    private boolean providerEnabled(String provider){try{return locationManager!=null&&locationManager.isProviderEnabled(provider);}catch(Exception error){return false;}}
    private void finishLocation(Location location,String error){
        locationGeneration++;Reply reply=locationReply;locationReply=null;if(locationTimeout!=null){ui.removeCallbacks(locationTimeout);locationTimeout=null;}if(locationCancel!=null){locationCancel.cancel();locationCancel=null;}if(locationListener!=null&&locationManager!=null){try{locationManager.removeUpdates(locationListener);}catch(Exception ignored){}locationListener=null;}
        if(reply!=null)reply.finish(location==null?null:object("latitude",location.getLatitude(),"longitude",location.getLongitude(),"accuracy",location.getAccuracy()),error);
    }
    private static String checkedToken(JSONObject payload)throws Exception{String base=payload.optString("base","");String token=payload.optString("token","");if(!SERVER.equals(base)&&!(SERVER+"/").equals(base))throw new Exception();if(!token.matches("[A-Za-z0-9_-]{32,200}"))throw new Exception();return token;}
    private static String filename(String name){name=name.replaceAll("[\\p{Cntrl}\\\\/]","_").trim();if(name.isEmpty())name="小紫在文件";if(name.length()>120)name=name.substring(0,120);return name;}
    private static final long DOWNLOAD_LIMIT=10L*1024*1024;
    private static final class DownloadProblem extends Exception {DownloadProblem(String message){super(message);}}
    private static final class DocumentGrant {
        final ContentResolver resolver;final Uri uri;final int flags;final AtomicBoolean released=new AtomicBoolean();
        DocumentGrant(ContentResolver resolver,Uri uri,int flags){this.resolver=resolver;this.uri=uri;this.flags=flags;}
        void release(){if(released.compareAndSet(false,true))try{resolver.releasePersistableUriPermission(uri,flags);}catch(Exception ignored){}}
    }
    private void clearOldDownloadCache(){
        // This private directory contains only bounded files created by this downloader.
        try{File directory=new File(activity.getCacheDir(),"ichat-downloads");File[] files=directory.listFiles();if(files!=null)for(File file:files)if(file.isFile()&&file.getName().matches("download-[a-f0-9-]{36}\\.tmp"))file.delete();}catch(Exception ignored){}
    }
    private boolean currentDownload(Reply reply,int operation,int epoch,int auth){return downloadReply==reply&&!downloadCancelled&&downloadGeneration==operation&&pageEpoch==epoch&&authenticationEpoch==auth;}
    private void requireDownload(Reply reply,int operation,int epoch,int auth)throws DownloadProblem{if(!currentDownload(reply,operation,epoch,auth))throw new DownloadProblem("已取消保存");}
    private String downloadFailure(Exception failure,String stage){
        if(failure instanceof DownloadProblem)return failure.getMessage();
        if(failure instanceof java.net.UnknownHostException)return "暂时无法连接文件服务器，请检查网络后重试";
        if(failure instanceof java.net.SocketTimeoutException)return "文件下载超时，请稍后重试";
        if(failure instanceof javax.net.ssl.SSLException)return "无法建立安全连接，请检查设备时间和网络后重试";
        return stage.startsWith("write")?"无法写入所选位置，请重新选择下载目录后重试":"文件下载失败，请检查网络后重试";
    }
    private String downloadReason(Exception failure){
        String message=failure.getMessage();if(message==null)return "none";String token=downloadToken;if(token!=null&&!token.isEmpty())message=message.replace(token,"[credential]");
        message=message.replaceAll("(?i)(?:https?|content|file)://[^\\s]+","[location]").replaceAll("[A-Za-z0-9_=-]{32,}","[value]").replaceAll("[\\p{Cntrl}]"," ");return message.length()>500?message.substring(0,500):message;
    }
    private void downloadMedia(JSONObject payload,Reply reply){
        if(downloadReply!=null){reply.finish(null,"请先完成当前文件保存");return;}
        try{downloadToken=checkedToken(payload);downloadId=payload.optString("id","");if(!downloadId.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))throw new Exception();downloadName=filename(payload.optString("filename","小紫在文件"));}
        catch(Exception error){downloadToken=null;downloadId=null;downloadName=null;reply.finish(null,"仅支持从正式小紫在服务器保存已授权文件");return;}
        downloadReply=reply;downloadRequest=-1;downloadCancelled=false;
        final int operation=++downloadGeneration,epoch=pageEpoch,auth=authenticationEpoch;final String token=downloadToken,id=downloadId;
        final File cache;
        try{File directory=new File(activity.getCacheDir(),"ichat-downloads");if(!directory.isDirectory()&&!directory.mkdirs())throw new Exception();cache=new File(directory,"download-"+UUID.randomUUID()+".tmp");downloadCache=cache;}
        catch(Exception error){finishDownload(null,"手机暂时没有可用的临时存储空间，请稍后重试");return;}
        // Finish and validate the authenticated transfer before creating a user document.
        try{io.execute(()->{
            HttpsURLConnection connection=null;String error=null,stage="connect";int status=-1;long size=0;
            try{
                requireDownload(reply,operation,epoch,auth);
                connection=(HttpsURLConnection)new URL(SERVER+"/api/media/"+id).openConnection();downloadConnection=connection;
                connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);connection.setConnectTimeout(10000);connection.setReadTimeout(15000);connection.setRequestProperty("Authorization","Bearer "+token);connection.setRequestProperty("Accept-Encoding","identity");
                stage="response";status=connection.getResponseCode();
                if(status==401)throw new DownloadProblem("登录已过期，请重新登录后保存");
                if(status==403)throw new DownloadProblem("当前账号无权保存这个文件，请刷新聊天后重试");
                if(status==404)throw new DownloadProblem("这个文件已不可用，请刷新聊天后重试");
                if(status!=200)throw new DownloadProblem("服务器暂时无法提供文件，请稍后重试");
                stage="headers";long expected=connection.getContentLengthLong();if(expected>DOWNLOAD_LIMIT)throw new DownloadProblem("文件超过 10 MB，无法保存");
                requireDownload(reply,operation,epoch,auth);stage="cache-transfer";
                try(InputStream source=connection.getInputStream();OutputStream output=new FileOutputStream(cache)){
                    byte[] buffer=new byte[32768];int count;while((count=source.read(buffer))!=-1){requireDownload(reply,operation,epoch,auth);size+=count;if(size>DOWNLOAD_LIMIT)throw new DownloadProblem("文件超过 10 MB，无法保存");output.write(buffer,0,count);}output.flush();
                }
                requireDownload(reply,operation,epoch,auth);if(size==0||(expected>=0&&size!=expected)||cache.length()!=size)throw new DownloadProblem("文件下载不完整，请重新保存");
                Log.i("iChatDownload","stage=cache-ready http="+status+" bytes="+size);
            }catch(Exception failure){error=downloadFailure(failure,stage);cache.delete();Log.w("iChatDownload","stage="+stage+" http="+status+" failure="+failure.getClass().getSimpleName());}
            finally{if(connection!=null)connection.disconnect();if(downloadConnection==connection)downloadConnection=null;}
            final String resultError=error;ui.post(()->{
                if(!currentDownload(reply,operation,epoch,auth)){cache.delete();return;}
                if(resultError!=null){finishDownload(null,resultError);return;}
                if(!valid()||!resumed){finishDownload(null,"请回到小紫在后重新保存文件");return;}
                downloadRequest=requestCode();Intent create=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,downloadName).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if(Build.VERSION.SDK_INT>=26)create.putExtra(DocumentsContract.EXTRA_INITIAL_URI,DocumentsContract.buildDocumentUri("com.android.externalstorage.documents","primary:Download"));
                try{activity.startActivityForResult(create,downloadRequest);}catch(Exception failure){Log.w("iChatDownload","stage=picker failure="+failure.getClass().getSimpleName());finishDownload(null,"无法打开系统保存文件对话框");}
            });
        });}catch(Exception failure){Log.w("iChatDownload","stage=queue failure="+failure.getClass().getSimpleName());finishDownload(null,"系统正忙，请稍后保存");}
    }
    private void saveDownload(Uri destination,int resultFlags){
        if(!"content".equals(destination.getScheme())||activity.getPackageName().concat(".camera").equals(destination.getAuthority())){finishDownload(null,"系统返回了无效保存位置");return;}
        final int grantFlags=resultFlags&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if((grantFlags&Intent.FLAG_GRANT_WRITE_URI_PERMISSION)==0){finishDownload(null,"系统未授予所选文件写入权限，请重新选择保存位置");return;}
        final DocumentGrant grant;
        if((resultFlags&Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)!=0){
            // Hold only the exact document offered by this picker result, and only for this save.
            // Release it on completion, cancellation, queue failure, logout, or Activity destruction.
            try{ContentResolver resolver=activity.getContentResolver();resolver.takePersistableUriPermission(destination,grantFlags);grant=new DocumentGrant(resolver,destination,grantFlags);downloadGrant=grant;Log.i("iChatDownload","stage=write-grant-taken flags="+grantFlags);}
            catch(Exception failure){Log.w("iChatDownload","stage=write-grant-take failure="+failure.getClass().getSimpleName()+" reason="+downloadReason(failure));finishDownload(null,"系统未授予所选文件写入权限，请重新选择保存位置；所选位置可能留有空文件");return;}
        }else grant=null;
        final Reply reply=downloadReply;final File cache=downloadCache;final String requestedName=downloadName;final int epoch=pageEpoch,operation=downloadGeneration,auth=authenticationEpoch;
        try{io.execute(()->{
            String error=null,stage="write-metadata",savedName=requestedName;boolean emptyCreatedDocument=false;
            try{
                requireDownload(reply,operation,epoch,auth);if(cache==null||!cache.isFile()||cache.length()==0||cache.length()>DOWNLOAD_LIMIT)throw new DownloadProblem("临时文件已失效，请重新保存");
                String authority=destination.getAuthority();if(authority==null||!authority.matches("[A-Za-z0-9_.-]{1,120}"))authority="other";
                Log.i("iChatDownload","stage=write-check authority="+authority+" document="+DocumentsContract.isDocumentUri(activity,destination)+" read="+activity.checkUriPermission(destination,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_READ_URI_PERMISSION)+" write="+activity.checkUriPermission(destination,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
                // ACTION_CREATE_DOCUMENT creates a new document, never overwrites an existing name.
                // Still refuse a non-empty destination and delete only a confirmed empty new document on failure.
                try(Cursor info=activity.getContentResolver().query(destination,new String[]{OpenableColumns.SIZE,OpenableColumns.DISPLAY_NAME},null,null,null)){
                    if(info!=null&&info.moveToFirst()){
                        long existingSize=info.isNull(0)?-1:info.getLong(0);if(existingSize>0)throw new DownloadProblem("所选位置未创建新文件，请重新选择保存位置");emptyCreatedDocument=existingSize==0&&DocumentsContract.isDocumentUri(activity,destination);
                        if(!info.isNull(1))savedName=filename(info.getString(1));
                    }
                }
                requireDownload(reply,operation,epoch,auth);stage="write-open";ParcelFileDescriptor descriptor=activity.getContentResolver().openFileDescriptor(destination,"w");if(descriptor==null)throw new DownloadProblem("无法打开所选位置，请重新选择保存位置");
                stage="write-copy";long expected=cache.length(),size=0;
                try(OutputStream output=new ParcelFileDescriptor.AutoCloseOutputStream(descriptor);InputStream source=new FileInputStream(cache)){
                    byte[] buffer=new byte[32768];int count;while((count=source.read(buffer))!=-1){requireDownload(reply,operation,epoch,auth);size+=count;if(size>DOWNLOAD_LIMIT)throw new DownloadProblem("文件超过 10 MB，无法保存");output.write(buffer,0,count);}output.flush();if(size!=expected)throw new DownloadProblem("文件保存不完整，请重新保存");
                }
                requireDownload(reply,operation,epoch,auth);Log.i("iChatDownload","stage=saved bytes="+size);
            }catch(Exception failure){
                error=downloadFailure(failure,stage);Log.w("iChatDownload","stage="+stage+" failure="+failure.getClass().getSimpleName()+" reason="+downloadReason(failure));
                boolean removed=false;if(emptyCreatedDocument)try{removed=DocumentsContract.deleteDocument(activity.getContentResolver(),destination);}catch(Exception ignored){}
                if(!removed)error+="；所选位置可能留有不完整文件";
            }finally{if(cache!=null)cache.delete();if(grant!=null)grant.release();}
            final String resultError=error,resultName=savedName;ui.post(()->{if(currentDownload(reply,operation,epoch,auth))finishDownload(resultError==null?object("saved",true,"filename",resultName):null,resultError);});
        });}catch(Exception failure){if(grant!=null)grant.release();Log.w("iChatDownload","stage=write-queue failure="+failure.getClass().getSimpleName());finishDownload(null,"系统正忙，请稍后保存");}
    }
    private void finishDownload(JSONObject data,String error){Reply reply=downloadReply;downloadReply=null;downloadRequest=-1;downloadCancelled=true;downloadGeneration++;downloadToken=null;downloadId=null;downloadName=null;File cache=downloadCache;downloadCache=null;if(cache!=null)cache.delete();DocumentGrant grant=downloadGrant;downloadGrant=null;if(grant!=null)grant.release();if(reply!=null)reply.finish(data,error);}
    private void cancelNativePickers(){
        if(actionDialog!=null){actionDialog.dismiss();actionDialog=null;}if(actionReply!=null){actionReply.finish(null,"已取消系统操作");actionReply=null;}
        if(contactRequest!=-1)activity.finishActivity(contactRequest);if(contactReply!=null)contactReply.finish(null,"已取消联系人选择");contactRequest=-1;contactReply=null;
        downloadCancelled=true;downloadGeneration++;HttpsURLConnection connection=downloadConnection;if(connection!=null){Thread close=new Thread(connection::disconnect,"iChat-close-download");close.setDaemon(true);close.start();}if(downloadRequest!=-1)activity.finishActivity(downloadRequest);finishDownload(null,"已取消保存");
    }
    private void startNotifications(JSONObject payload,Reply reply){
        final String token;final int auth=authenticationEpoch;try{token=checkedToken(payload);}catch(Exception error){reply.finish(null,"持续提醒仅连接正式 HTTPS 小紫在服务器");return;}
        if(actionDialog!=null){reply.finish(null,"请先完成当前系统操作");return;}
        actionReply=reply;actionDialog=new AlertDialog.Builder(activity).setTitle("开启持续消息提醒").setMessage("开启后状态栏会保留通知，小紫在定期连接服务器读取消息提醒。仅本次开启，最长 5 小时；Android 15 对此类后台服务合计限制为 24 小时内 6 小时，系统省电也可能暂停服务。它不等同于系统离线推送，你可以随时关闭。").setNegativeButton("取消",(dialog,which)->{actionDialog=null;actionReply=null;reply.finish(null,"已取消开启");}).setPositiveButton("开启",(dialog,which)->{actionDialog=null;actionReply=null;
            Runnable start=()->{
                notificationPermissionPending=false;if(!valid()||!resumed||auth!=authenticationEpoch){reply.finish(null,"请在小紫在前台重新开启提醒");return;}
                if(!"granted".equals(permissionState().optString("notifications"))){reply.finish(null,"未允许通知，请在系统应用设置中开启");return;}
                try{long ticket=MessageNotificationService.markStarting();Intent service=new Intent(activity,MessageNotificationService.class).setAction(MessageNotificationService.START).putExtra("token",token).putExtra("startTicket",ticket);if(Build.VERSION.SDK_INT>=26)activity.startForegroundService(service);else activity.startService(service);reply.finish(object("notificationsActive",true,"maxHours",5),null);}catch(Exception error){MessageNotificationService.clearStarting();reply.finish(null,"系统暂时不允许开启持续提醒，请保持应用前台后重试");}
            };
            if(Build.VERSION.SDK_INT>=33){notificationPermissionPending=true;requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},start,(data,error)->{notificationPermissionPending=false;reply.finish(data,error);});}else start.run();
        }).setOnCancelListener(dialog->{actionDialog=null;actionReply=null;reply.finish(null,"已取消开启");}).create();actionDialog.show();
    }
}
