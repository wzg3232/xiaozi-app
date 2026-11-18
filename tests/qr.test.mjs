import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../web/assets/vendor-qrcode.js';
import jsQR from '../web/assets/vendor-jsqr.js';

test('bundled QR generator produces codes the bundled scanner can read',()=>{
  for(const username of ['alice_123','abc','very_long_account_20']){
    const text='ichat://user/'+username,qr=qrcode(0,'M');qr.addData(text);qr.make();
    const cell=8,margin=4,width=(qr.getModuleCount()+margin*2)*cell,pixels=new Uint8ClampedArray(width*width*4).fill(255);
    for(let r=0;r<qr.getModuleCount();r++)for(let c=0;c<qr.getModuleCount();c++)if(qr.isDark(r,c))for(let y=0;y<cell;y++)for(let x=0;x<cell;x++){const offset=((r+margin)*cell+y)*width*4+((c+margin)*cell+x)*4;pixels[offset]=pixels[offset+1]=pixels[offset+2]=0;}
    assert.equal(jsQR(pixels,width,width).data,text);
  }
});
test('scan results accept only iChat public user codes and never arbitrary links',async()=>{
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const {parseUserCode}=await import('../web/assets/qr.js');
  assert.equal(parseUserCode('ichat://user/alice_123'),'alice_123');
  assert.equal(parseUserCode('https://chat.pvdust.com/?add=alice_123'),'alice_123');
  for(const text of ['javascript:alert(1)','https://chat.pvdust.com.attacker.test/?add=alice','https://evil.test/?add=alice','ichat://token@user/alice','ichat://user/alice?token=x','ichat://user/alice/bob','https://chat.pvdust.com/?add=alice&add=bob','https://chat.pvdust.com/?add=alice&token=secret','ichat://user/%3Cscript%3E'])assert.equal(parseUserCode(text),null,text);
});
