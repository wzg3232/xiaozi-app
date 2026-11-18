// Microphone capture worklet. Only instantiated after explicit call acceptance.
class IChatPcmCapture extends AudioWorkletProcessor{
  constructor(){super();this.parts=[];this.length=0;this.target=Math.ceil(sampleRate*.04);}
  process(inputs){const channel=inputs[0]?.[0];if(channel){this.parts.push(new Float32Array(channel));this.length+=channel.length;if(this.length>=this.target){const out=new Float32Array(this.length);let offset=0;for(const part of this.parts){out.set(part,offset);offset+=part.length;}this.port.postMessage(out,[out.buffer]);this.parts=[];this.length=0;}}return true;}
}
registerProcessor('ichat-pcm-capture',IChatPcmCapture);
