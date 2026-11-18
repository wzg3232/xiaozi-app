import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// Preparing bundled resources works on Windows as well as macOS. Compiling and
// signing the native application is a separate Xcode step on a Mac.
const root=resolve(import.meta.dirname,'..');
const cli=resolve(root,'node_modules/@capacitor/cli/bin/capacitor');
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
const project=readFileSync(resolve(root,'ios/App/App.xcodeproj/project.pbxproj'),'utf8');
const versions=[...project.matchAll(/MARKETING_VERSION = ([\d.]+);/g)];
if(versions.length!==2||versions.some(m=>m[1]!==version))throw Error('Update both iOS target version settings before preparing the project.');
// Capacitor replaces this managed resources directory during copy. Resolve its
// entire parent chain before allowing that operation, including on Windows.
for(const name of ['ios','ios/App','ios/App/App','ios/App/App/public','dist']){
  const folder=resolve(root,name),stat=lstatSync(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(folder)!==folder)throw Error('Unexpected iOS resource path: '+name);
}
function run(file,args,env=process.env){
  const result=spawnSync(process.execPath,[file,...args],{cwd:root,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
run(resolve(root,'scripts/build-web.mjs'),[],{...process.env,ICHAT_SERVER_URL:process.env.ICHAT_SERVER_URL||'https://chat.pvdust.com'});
run(cli,['copy','ios']);
console.log(`Prepared 小紫在 ${version} iOS resources. Native compilation and Apple signing still require Xcode on macOS.`);
