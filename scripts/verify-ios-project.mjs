import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),plist=require('plist'),xcode=require('xcode');
const root=resolve(import.meta.dirname,'..'),read=p=>readFileSync(resolve(root,p));
const pkg=JSON.parse(read('package.json'));
const appConfig=JSON.parse(read('capacitor.config.json'));
const buildNumber=12;
const project=xcode.project(resolve(root,'ios/App/App.xcodeproj/project.pbxproj')).parseSync();
const settings=Object.values(project.pbxXCBuildConfigurationSection()).filter(c=>c?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER);
assert.equal(settings.length,2);
for(const config of settings){
  assert.equal(String(config.buildSettings.MARKETING_VERSION),pkg.version);
  assert.equal(Number(config.buildSettings.CURRENT_PROJECT_VERSION),buildNumber);
  assert.equal(config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER,appConfig.appId);
  assert.equal(Number(config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET),15);
}
const info=plist.parse(read('ios/App/App/Info.plist').toString());
assert.equal(info.CFBundleDisplayName,appConfig.appName);
assert.deepEqual(info.UISupportedInterfaceOrientations,['UIInterfaceOrientationPortrait']);
for(const key of ['NSCameraUsageDescription','NSMicrophoneUsageDescription','NSLocationWhenInUseUsageDescription'])assert(info[key]?.length>10,key);
assert.equal(info.NSAppTransportSecurity?.NSAllowsArbitraryLoads,undefined);
const cap=JSON.parse(read('ios/App/App/capacitor.config.json'));
assert.equal(cap.appId,appConfig.appId);
assert.equal(cap.appName,appConfig.appName);
assert.equal(cap.server.url,undefined,'Bundle local resources rather than load a remote website as the application');
assert.equal(cap.ios.scheme,undefined,'Keep the standard Capacitor iOS scheme');
const spm=read('ios/App/CapApp-SPM/Package.swift').toString();
assert(spm.includes('exact: "'+pkg.devDependencies['@capacitor/ios']+'"'));
const scheme=read('ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme').toString();
assert(scheme.includes('BlueprintIdentifier="504EC3031FED79650016851F"'));
assert(scheme.includes('<ArchiveAction buildConfiguration="Release"'));
const bundled=JSON.parse(read('ios/App/App/public/build-info.json'));
assert.equal(bundled.version,pkg.version);assert.equal(bundled.fixedServer,true);
const fixed=read('ios/App/App/public/assets/config.js').toString();
assert(fixed.includes('"serverUrl":"https://chat.pvdust.com"')&&fixed.includes('"lockServer":true'));
const sha=b=>createHash('sha256').update(b).digest('hex'),files=[];
function verifyFolder(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){
  const file=join(folder,entry.name);
  if(entry.isDirectory()){verifyFolder(file);continue;}
  assert(entry.isFile(),'Unexpected symlink');
  const name=relative(resolve(root,'dist'),file).replaceAll('\\','/');
  assert(!/\.(apk|ipa|zip)$/.test(name),'Do not bundle installation archives');
  const counterpart=resolve(root,'ios/App/App/public',name);
  assert(existsSync(counterpart),name);
  const bytes=readFileSync(file);assert.equal(sha(readFileSync(counterpart)),sha(bytes),name);
  files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
}}
verifyFolder(resolve(root,'dist'));
const assetCatalog='ios/App/App/Assets.xcassets/AppIcon.appiconset';
const icons=JSON.parse(read(assetCatalog+'/Contents.json')).images;
for(const icon of icons){if(icon.filename)assert(existsSync(resolve(root,assetCatalog,icon.filename)));}
const proof={preparedAt:new Date().toISOString(),appName:appConfig.appName,version:pkg.version,buildNumber,server:'https://chat.pvdust.com',minimumIos:'15.0',requiredXcode:'26.0+',nativeCompilationPerformed:false,appleSigningPerformed:false,iphoneDeviceTestPerformed:false,checks:{xcodeProjectParses:true,versionSettingsMatch:true,displayNameMatches:true,iphonePortraitOnly:true,permissionDescriptionsPresent:true,swiftPackagePinned:true,sharedArchiveSchemePresent:true,bundledFilesMatch:true,fixedHttpsServer:true,appIconFilesPresent:true},files};
writeFileSync(resolve(root,'ios/prepared-build.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify({version:proof.version,buildNumber:proof.buildNumber,files:files.length,checks:proof.checks,nativeCompilationPerformed:false}));
