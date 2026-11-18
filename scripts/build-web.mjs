import {cpSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
// Bundle the exact pinned QR libraries. Runtime never downloads script from a CDN.
const qrSource=resolve(root,'node_modules/qrcode-generator/dist/qrcode.mjs');
const scanSource=resolve(root,'node_modules/jsqr/dist/jsQR.js');
writeFileSync(resolve(root,'web/assets/vendor-qrcode.js'),readFileSync(qrSource));
writeFileSync(resolve(root,'web/assets/vendor-jsqr.js'),'const module={exports:{}}; const exports=module.exports;\n'+readFileSync(scanSource,'utf8')+'\nexport default module.exports;\n');
mkdirSync(resolve(root,'dist'),{recursive:true});
cpSync(resolve(root,'web'),resolve(root,'dist'),{recursive:true});
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
const address=process.env.ICHAT_SERVER_URL?.trim();
const assetHash=createHash('sha256').update(version).update(address||'');
for(const name of readdirSync(resolve(root,'web','assets')).sort())assetHash.update(readFileSync(resolve(root,'web','assets',name)));
const stamp=version+'-'+assetHash.digest('hex').slice(0,10);
const indexFile=resolve(root,'dist','index.html');
writeFileSync(indexFile,readFileSync(indexFile,'utf8').replace(/((?:src|href)="\.\/assets\/[^"?]+)(")/g,'$1?v='+stamp+'$2'));
for(const name of readdirSync(resolve(root,'dist','assets')).filter(name=>name.endsWith('.js'))){
  const file=resolve(root,'dist','assets',name);
  writeFileSync(file,readFileSync(file,'utf8').replace(/(from\s+|import\s+)(['"])(\.\/[^'"?]+\.js)\2/g,'$1$2$3?v='+stamp+'$2'));
}
if(address){
  const url=new URL(address);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw new Error('ICHAT_SERVER_URL must be an HTTPS origin without credentials or a path.');
  writeFileSync(resolve(root,'dist','assets','config.js'),'window.ICHAT_CONFIG = '+JSON.stringify({serverUrl:url.origin,lockServer:true})+';\n');
}
writeFileSync(resolve(root,'dist','build-info.json'),JSON.stringify({name:'小紫在',version,builtAt:new Date().toISOString(),fixedServer:!!address}));
console.log('Built 小紫在 web assets for browser, Android and iOS.');
