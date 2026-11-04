













var A=require('celeros.app');

A.text={
version:'1.0.1',


fit:function(s){
return String(s===null||s===undefined?'':s)
.replace(/[^\u0000-\u00ff\n]/g,'');
},


lines:function(s,w,l){
try{return UI.measureWrap(s,w,l||'body');}catch(e){return 1;}
},



viewer:function(n,j){
var T=A.T||System.theme();
var s=A.text.fit(j());
UI.resetScroll('kit:leitor');
UI.invalidate();
var c=48;
var h=320-c-6;
for(;;){
UI.begin(T.bg);
if(UI.header(n,{back:true}))return;
var i=UI.measureWrap(s,216,'body');
var k=UI.scrollBegin('kit:leitor',4,c,232,h,Math.max(h,i+8));

UI.text(s,12,c+4-k,{w:216,lines:64});
UI.scrollEnd();
UI.end(30);
}
}
};

A._mods.push('text');

module.exports=A;
