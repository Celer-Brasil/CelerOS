













var A=require('celeros.app');

A.text={
version:'1.1.0',


fit:function(s){
return String(s===null||s===undefined?'':s)
.replace(/[^\u0000-\u00ff\n]/g,'');
},


lines:function(s,w,m){
try{return UI.measureWrap(s,w,m||'body');}catch(e){return 1;}
},



viewer:function(o,k,i){
var T=A.T||System.theme();
var s=A.text.fit(k());
UI.resetScroll('kit:leitor');
UI.invalidate();
var L=A.L||A.init().L;
var a=i||{x:L.x,y:L.top,w:L.w,h:L.bottom-L.top};
var w=a.w-12;
var j=UI.measureWrap(s,w,'body')+12;
for(;;){
UI.begin(T.bg);
if(UI.header(o,{back:true})){UI.end(0);UI.invalidate();return;}
var l=UI.scrollBegin('kit:leitor',a.x,a.y,a.w,a.h,Math.max(a.h,j));

UI.text(s,a.x+6,a.y+6-l,{role:'body',w:w,lines:64});
UI.scrollEnd();
UI.end(30);
}
}
};

A._mods.push('text');

module.exports=A;
