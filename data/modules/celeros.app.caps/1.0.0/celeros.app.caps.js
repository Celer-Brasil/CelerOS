
















var A=require('celeros.app');

A.caps={
version:'1.0.0',
_c:null,

probe:function(){
if(A.caps._c)return A.caps._c;
var a={};
try{a=System.getInfo()||{};}catch(e){a={};}
var d=0;
try{d=System.getAPILevel()||0;}catch(e){d=0;}
var g=(a.totalPSRAM||0)>0;
var c={
api:d,
board:a.board||'',
w:a.screenW||240,
h:a.screenH||320,
inset:a.inset||0,
shape:a.shape||'rect',
psram:g,
battery:!!a.hasBattery,
speaker:!!a.hasSpeaker,
led:!!a.hasLed,
light:!!a.hasLightSensor,
touch:typeof UI!=='undefined',
mic:typeof Mic!=='undefined',
camera:typeof Camera!=='undefined',
bt:typeof CelerNet!=='undefined'&&typeof Pack!=='undefined',
phone:typeof Phone!=='undefined',
small:!g&&(a.flashSize||0)<=8*1024*1024
};
A.caps._c=c;
return c;
},

has:function(h){return!!A.caps.probe()[h];}
};

A._mods.push('caps');

module.exports=A;
