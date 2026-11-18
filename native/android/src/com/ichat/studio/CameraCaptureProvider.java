package com.ichat.studio;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Non-exported provider. Android URI grants expose only one freshly created cache photo. */
public final class CameraCaptureProvider extends ContentProvider {
    @Override public boolean onCreate(){return true;}
    private File photo(Uri uri)throws FileNotFoundException {
        try{
            if(!"content".equals(uri.getScheme())||!getContext().getPackageName().concat(".camera").equals(uri.getAuthority())||uri.getPathSegments().size()!=2||!"capture".equals(uri.getPathSegments().get(0)))throw new Exception();
            String name=uri.getLastPathSegment();if(name==null||!name.matches("capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.jpg"))throw new Exception();
            File folder=new File(getContext().getCacheDir(),"camera-capture").getCanonicalFile(),file=new File(folder,name).getCanonicalFile();
            if(!folder.equals(file.getParentFile())||!file.isFile())throw new Exception();return file;
        }catch(Exception error){throw new FileNotFoundException("Only the granted 小紫在 capture is available");}
    }
    @Override public String getType(Uri uri){try{photo(uri);return "image/jpeg";}catch(FileNotFoundException error){return null;}}
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException {
        File file=photo(uri);if(!"r".equals(mode)&&!"w".equals(mode)&&!"wt".equals(mode)&&!"rw".equals(mode)&&!"rwt".equals(mode))throw new FileNotFoundException("Unsupported capture access mode");
        return ParcelFileDescriptor.open(file,ParcelFileDescriptor.parseMode(mode));
    }
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){
        try{File file=photo(uri);String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection;MatrixCursor cursor=new MatrixCursor(columns,1);Object[] values=new Object[columns.length];for(int i=0;i<columns.length;i++)values[i]=OpenableColumns.DISPLAY_NAME.equals(columns[i])?file.getName():OpenableColumns.SIZE.equals(columns[i])?file.length():null;cursor.addRow(values);return cursor;}catch(FileNotFoundException error){return null;}
    }
    @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
    @Override public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
}
