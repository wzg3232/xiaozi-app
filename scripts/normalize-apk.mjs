import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {readFileSync,writeFileSync,statSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const maxArchive=128*1024*1024,maxEntry=64*1024*1024,maxExpanded=256*1024*1024,maxEntries=20000;
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function reject(message){throw Error('APK ZIP: '+message);}
function range(bytes,offset,length,label){if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>bytes.length)reject('truncated '+label);}
function normalizeName(raw){
  const decoded=raw.toString('utf8');
  if(!Buffer.from(decoded,'utf8').equals(raw))reject('entry name is not valid UTF-8');
  const name=decoded.replaceAll('\\','/');
  if(!name||name.startsWith('/')||name.includes('\0')||name.includes(':')||name.split('/').some((part,i,parts)=>part==='.'||part==='..'||part===''&&i!==parts.length-1))reject('unsafe entry name');
  return name;
}
// ZIP32 only: aapt2 emits small unsigned archives. Reject ambiguous/encrypted/
// ZIP64 input instead of silently copying a damaged package into a signed APK.
export function readZip32(input){
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input);
  if(bytes.length>maxArchive)reject('archive exceeds size limit');
  let end=-1;
  for(let pos=bytes.length-22;pos>=Math.max(0,bytes.length-65557);pos--){
    if(bytes.readUInt32LE(pos)===0x06054b50&&pos+22+bytes.readUInt16LE(pos+20)===bytes.length){end=pos;break;}
  }
  if(end<0)reject('missing end record');
  const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count)reject('multiple ZIP disks are unsupported');
  if(count===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff)reject('ZIP64 is unsupported');
  if(count>maxEntries)reject('too many entries');
  range(bytes,centralOffset,centralSize,'central directory');
  if(centralOffset+centralSize!==end)reject('central directory boundary mismatch');
  const entries=[],names=new Set(),intervals=[];let cursor=centralOffset,expanded=0;
  for(let i=0;i<count;i++){
    range(bytes,cursor,46,'central entry');
    if(bytes.readUInt32LE(cursor)!==0x02014b50)reject('invalid central entry');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressedSize=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),disk=bytes.readUInt16LE(cursor+34),localOffset=bytes.readUInt32LE(cursor+42);
    if(flags&~(0x800|0x8|0x6)||![0,8].includes(method))reject('encrypted or unsupported compression');
    if(disk||[compressedSize,size,localOffset].includes(0xffffffff))reject('multi-disk or ZIP64 entry');
    if(size>maxEntry||(expanded+=size)>maxExpanded)reject('expanded data exceeds size limit');
    range(bytes,cursor+46,nameLength+extraLength+commentLength,'entry metadata');
    const rawName=bytes.subarray(cursor+46,cursor+46+nameLength),name=normalizeName(rawName);
    if(names.has(name))reject('duplicate normalized entry: '+name);names.add(name);
    range(bytes,localOffset,30,'local entry');
    if(bytes.readUInt32LE(localOffset)!==0x04034b50||bytes.readUInt16LE(localOffset+6)!==flags||bytes.readUInt16LE(localOffset+8)!==method)reject('local header disagrees with central directory');
    const localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28),dataOffset=localOffset+30+localNameLength+localExtraLength;
    range(bytes,localOffset+30,localNameLength+localExtraLength,'local metadata');
    if(!bytes.subarray(localOffset+30,localOffset+30+localNameLength).equals(rawName))reject('local entry name disagrees with central directory');
    for(const [position,value]of [[14,crc],[18,compressedSize],[22,size]]){
      const localValue=bytes.readUInt32LE(localOffset+position);
      if(localValue!==value&&(!(flags&8)||localValue!==0))reject('local size or CRC disagrees with central directory');
    }
    range(bytes,dataOffset,compressedSize,'compressed data');
    if(dataOffset+compressedSize>centralOffset)reject('entry overlaps central directory');
    const compressed=bytes.subarray(dataOffset,dataOffset+compressedSize);let data;
    try{data=method===0?compressed:inflateRawSync(compressed,{maxOutputLength:Math.max(1,size+1)});}catch{reject('invalid or oversized deflate data');}
    if(data.length!==size||crc32(data)!==crc)reject('entry size or CRC mismatch: '+name);
    entries.push({name,data,compressed,method,crc,time:bytes.readUInt16LE(cursor+12),date:bytes.readUInt16LE(cursor+14),attributes:bytes.readUInt32LE(cursor+38),dataOffset,localOffset});
    intervals.push([localOffset,dataOffset+compressedSize]);cursor+=46+nameLength+extraLength+commentLength;
  }
  if(cursor!==centralOffset+centralSize)reject('central entry count mismatch');
  intervals.sort((a,b)=>a[0]-b[0]);for(let i=1;i<intervals.length;i++)if(intervals[i][0]<intervals[i-1][1])reject('overlapping entries');
  return entries;
}
function writeZip32(entries){
  const localParts=[],centralParts=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8'),crc=crc32(entry.data),method=entry.method,compressed=method===0?entry.data:entry.compressed||deflateRawSync(entry.data,{level:9});
    if(name.length>65535)reject('entry name too long');
    // Real ZIP method 0 is required for resources.arsc on modern Android.
    // A valid local extra field pads every stored entry to a 4-byte boundary.
    const padding=method===0?(4-((offset+30+name.length)%4))%4:0,extra=padding?Buffer.alloc(4+padding):Buffer.alloc(0);
    if(extra.length){extra.writeUInt16LE(0xcafe,0);extra.writeUInt16LE(padding,2);}
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);local.writeUInt16LE(entry.time||0,10);local.writeUInt16LE(entry.date||0,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);
    localParts.push(local,name,extra,compressed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt16LE(entry.time||0,12);central.writeUInt16LE(entry.date||0,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(entry.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(entry.attributes||0,38);central.writeUInt32LE(offset,42);
    centralParts.push(central,name);offset+=local.length+name.length+extra.length+compressed.length;if(offset>maxArchive)reject('normalized archive exceeds size limit');
  }
  const central=Buffer.concat(centralParts),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  if(offset+central.length+22>maxArchive)reject('normalized archive exceeds size limit');
  return Buffer.concat([...localParts,central,end]);
}
export function normalizeApk(archive,dex){
  const entries=readZip32(archive);
  if(entries.length>=maxEntries)reject('too many entries to add classes.dex');
  if(!entries.some(entry=>entry.name==='AndroidManifest.xml')||!entries.some(entry=>entry.name==='resources.arsc'))reject('manifest or resource table is missing');
  if(entries.some(entry=>/^classes(?:\d+)?\.dex$/i.test(entry.name)))reject('aapt input must not already contain DEX files');
  if(!Buffer.isBuffer(dex))dex=Buffer.from(dex);
  if(dex.length<112||dex.length>maxEntry||!/^dex\n\d{3}\0$/.test(dex.subarray(0,8).toString('latin1')))reject('classes.dex is not a bounded DEX file');
  const output=writeZip32([...entries.map(entry=>({...entry,method:entry.name==='resources.arsc'||/\.png$/i.test(entry.name)||entry.name.endsWith('/')?0:8,compressed:entry.method===8?entry.compressed:null})),{name:'classes.dex',data:dex,method:8}]);
  const verified=readZip32(output);
  for(const entry of verified)if((entry.name==='resources.arsc'||/\.png$/i.test(entry.name))&&(entry.method!==0||entry.dataOffset%4))reject('stored Android resource alignment failed');
  return output;
}
function boundedFile(path,maximum){const stat=statSync(path);if(!stat.isFile()||stat.size>maximum)reject('input file exceeds size limit');return readFileSync(path);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let temporary;
  try{
    if(process.argv.length!==5)throw Error('Usage: node scripts/normalize-apk.mjs unsigned.apk classes.dex normalized.apk');
    const [inputPath,dexPath,outputPath]=process.argv.slice(2).map(path=>resolve(path));
    if([inputPath,dexPath].some(path=>path.toLowerCase()===outputPath.toLowerCase()))reject('output must differ from both input paths');
    const bytes=normalizeApk(boundedFile(inputPath,maxArchive),boundedFile(dexPath,maxEntry));
    temporary=outputPath+'.'+randomUUID()+'.tmp';writeFileSync(temporary,bytes,{flag:'wx'});renameSync(temporary,outputPath);temporary=null;
    console.log(JSON.stringify({normalized:true,entries:readZip32(bytes).length,resourcesStored:true,storedAlignment:4,bytes:bytes.length}));
  }catch(error){if(temporary)try{unlinkSync(temporary);}catch{}console.error(error.message);process.exitCode=1;}
}
