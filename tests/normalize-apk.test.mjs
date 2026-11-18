import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {crc32,readZip32,normalizeApk} from '../scripts/normalize-apk.mjs';

const dex=Buffer.alloc(128);dex.write('dex\n035\0','latin1');
const baseEntries=()=>[{name:'AndroidManifest.xml',data:Buffer.from('compiled-manifest'),method:8},{name:'resources.arsc',data:Buffer.from('compiled-resource-table'),method:8,level:0},{name:'res\\mipmap\\icon.png',data:Buffer.from([137,80,78,71,13,10,26,10]),method:8,level:0},{name:'assets\\assets\\app.js',data:Buffer.from('console.log("app");'),method:8}];
// Independent fixture encoder includes the data-descriptor form emitted by
// streaming ZIP libraries. Production normalization never uses this encoder.
function zip(entries){
  const localParts=[],centralParts=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name),data=Buffer.from(entry.data||''),method=entry.method??8,packed=method===8?deflateRawSync(data,{level:entry.level??9}):data,flags=0x800|(entry.descriptor?8:0),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(flags,6);header.writeUInt16LE(method,8);header.writeUInt16LE(name.length,26);if(!entry.descriptor){header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(data.length,22);}
    const descriptor=entry.descriptor?Buffer.alloc(16):Buffer.alloc(0);if(entry.descriptor){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(packed.length,8);descriptor.writeUInt32LE(data.length,12);}
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    localParts.push(header,name,packed,descriptor);centralParts.push(central,name);offset+=header.length+name.length+packed.length+descriptor.length;
  }
  const central=Buffer.concat(centralParts),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...localParts,central,end]);
}
test('CRC32 agrees with standard vectors',()=>{
  assert.equal(crc32(Buffer.alloc(0)),0);assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
});
test('Framework deflate-level-zero resources become actual stored ZIP entries with four-byte aligned data',()=>{
  const source=zip(baseEntries()),output=normalizeApk(source,dex),entries=readZip32(output);
  assert.equal(readZip32(source).find(entry=>entry.name==='resources.arsc').method,8);
  for(const name of ['resources.arsc','res/mipmap/icon.png']){
    const entry=entries.find(entry=>entry.name===name);assert.equal(entry.method,0);assert.equal(output.readUInt16LE(entry.localOffset+8),0);assert.equal(entry.dataOffset%4,0);assert.deepEqual(output.subarray(entry.dataOffset,entry.dataOffset+entry.data.length),entry.data);
  }
  assert.equal(entries.some(entry=>entry.name.includes('\\')),false);assert.deepEqual(entries.find(entry=>entry.name==='classes.dex').data,dex);
  // Read the central directory's compression fields directly, independently
  // of the production parser's method value.
  let cursor=output.readUInt32LE(output.length-6);const methods=new Map();
  for(let i=0;i<entries.length;i++){assert.equal(output.readUInt32LE(cursor),0x02014b50);const length=output.readUInt16LE(cursor+28);methods.set(output.subarray(cursor+46,cursor+46+length).toString(),output.readUInt16LE(cursor+10));cursor+=46+length+output.readUInt16LE(cursor+30)+output.readUInt16LE(cursor+32);}
  assert.equal(methods.get('resources.arsc'),0);assert.equal(methods.get('res/mipmap/icon.png'),0);
});
test('normalization preserves Unicode asset bytes and deflate streams and handles data descriptors',()=>{
  const original=baseEntries();original.push({name:'assets\\资料\\测试.txt',data:Buffer.from('中文🌸资料'),method:8,descriptor:true},{name:'assets/empty/',data:Buffer.alloc(0),method:0});
  const input=zip(original),before=readZip32(input),after=readZip32(normalizeApk(input,dex));
  for(const entry of before){const output=after.find(item=>item.name===entry.name);assert.deepEqual(output.data,entry.data);if(entry.method===8&&!entry.name.endsWith('.png')&&entry.name!=='resources.arsc')assert.deepEqual(output.compressed,entry.compressed);}
  assert.equal(after.find(entry=>entry.name==='assets/资料/测试.txt').data.toString(),'中文🌸资料');
});
test('stored resource padding handles every possible local-name alignment',()=>{
  const entries=baseEntries();for(let n=0;n<8;n++)entries.push({name:'res/'+'a'.repeat(n)+'.PNG',data:Buffer.alloc(n,7),method:8});
  for(const entry of readZip32(normalizeApk(zip(entries),dex)))if(entry.method===0)assert.equal(entry.dataOffset%4,0,entry.name);
});
test('CRC damage, truncated archives, unsupported compression, encryption and ZIP64 are rejected',()=>{
  const original=zip(baseEntries()),damaged=Buffer.from(original),first=readZip32(original)[0];damaged[first.dataOffset]^=255;assert.throws(()=>readZip32(damaged),/deflate|CRC/);
  assert.throws(()=>readZip32(original.subarray(0,original.length-1)),/end record/);
  const central=original.readUInt32LE(original.length-6);
  for(const change of [bytes=>bytes.writeUInt16LE(9,central+10),bytes=>bytes.writeUInt16LE(1,central+8),bytes=>bytes.writeUInt32LE(0xffffffff,central+24),bytes=>bytes.writeUInt32LE(original.length+1,central+42)]){
    const bytes=Buffer.from(original);change(bytes);assert.throws(()=>readZip32(bytes),/ZIP|truncated/);
  }
});
test('unsafe and colliding normalized paths cannot enter the APK',()=>{
  for(const name of ['../evil','/root','C:\\escape','assets/../evil','assets//evil','assets/./evil']){
    assert.throws(()=>normalizeApk(zip([...baseEntries(),{name,data:Buffer.from('x')}]),dex),/unsafe/);
  }
  assert.throws(()=>normalizeApk(zip([...baseEntries(),{name:'assets/assets/app.js',data:Buffer.from('duplicate')}]),dex),/duplicate/);
});
test('missing resource table, duplicate DEX input and invalid DEX are rejected',()=>{
  assert.throws(()=>normalizeApk(zip(baseEntries().filter(entry=>entry.name!=='resources.arsc')),dex),/resource table/);
  assert.throws(()=>normalizeApk(zip([...baseEntries(),{name:'classes.dex',data:dex}]),dex),/already contain DEX/);
  assert.throws(()=>normalizeApk(zip(baseEntries()),Buffer.from('not-dex')),/DEX file/);
});
test('CLI handles paths with spaces and writes a ZIP accepted by Android zipalign when the SDK is available',()=>{
  const temporary=mkdtempSync(join(tmpdir(),'xiaozi apk zip test '));
  try{
    const input=join(temporary,'unsigned 输入.apk'),dexPath=join(temporary,'classes.dex'),output=join(temporary,'normalized 输出.apk');writeFileSync(input,zip(baseEntries()));writeFileSync(dexPath,dex);
    const result=spawnSync(process.execPath,[resolve('scripts/normalize-apk.mjs'),input,dexPath,output],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).resourcesStored,true);assert.equal(readZip32(readFileSync(output)).length,5);
    const zipalign=resolve('build-tools/android-sdk/build-tools/36.0.0/zipalign.exe');
    if(existsSync(zipalign)){
      const check=spawnSync(zipalign,['-c','-p','4',output],{encoding:'utf8',windowsHide:true});assert.equal(check.status,0,check.stdout+check.stderr);
      const aligned=join(temporary,'aligned.apk'),align=spawnSync(zipalign,['-f','-p','4',output,aligned],{encoding:'utf8',windowsHide:true});assert.equal(align.status,0,align.stdout+align.stderr);assert.equal(readZip32(readFileSync(aligned)).find(entry=>entry.name==='resources.arsc').method,0);
    }
    const samePath=spawnSync(process.execPath,[resolve('scripts/normalize-apk.mjs'),input,dexPath,input],{encoding:'utf8',windowsHide:true});assert.notEqual(samePath.status,0);assert.deepEqual(readFileSync(input),zip(baseEntries()));
  }finally{rmSync(temporary,{recursive:true,force:true});}
});
