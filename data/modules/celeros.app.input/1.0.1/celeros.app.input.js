



















var A=require('celeros.app');

A.input={
version:'1.0.1',
_kb:false,
_top:320,
_last:null,



open:function(o){
o=o||{};
A.input._last=o;
var c=false;
try{c=!!System.keypadOpen({field:false,maxLen:o.maxLen||256});}
catch(e){c=false;}
A.input._kb=c;
A.input._top=320;
if(c){
try{
var r=System.keypadRect();
if(r&&r.y)A.input._top=r.y;
}catch(e2){}
if(o.chips&&typeof System.topbarButtons==='function'){
System.topbarButtons(o.chips);
}
}
return c;
},


top:function(){return A.input._top;},
ativo:function(){return A.input._kb;},


text:function(){
try{return System.keypadText()||'';}catch(e){return'';}
},



poll:function(){
if(!A.input._kb)return null;
var f=null;
try{f=System.keypadPoll();}catch(e){return null;}
if(!f)return null;
if(f.type==='cancel'){
A.input.open(A.input._last||{});
UI.invalidate();
}
return f;
},



redraw:function(l){
if(l&&A.input._kb){
try{System.keypadDraw();}catch(e){}
}
},



line:function(n){
var T=A.T||System.theme();
var y=A.input._top-36;
UI.card(6,y,228,30,{radius:15,stroke:true});
var s=System.keypadText()||'';
var k=(Math.floor(System.millis()/500)%2)?'_':' ';
var d=s;
while(d.length&&UI.measure(d+'_','body')>200)d=d.substring(1);
if(s.length||k==='_'){
UI.text(d+k,18,y+7,{color:s.length?T.text:T.textDim,id:1});
}else{
UI.text(n||'Mensagem',18,y+7,{color:T.textDim,id:1});
}
UI.cardEnd();
},


chips:function(m){
if(typeof System.topbarButtons==='function')System.topbarButtons(m);
},
chip:function(){
if(typeof System.topbarPop!=='function')return null;
try{return System.topbarPop();}catch(e){return null;}
},

close:function(){
A.input._kb=false;
try{if(System.keypadClose)System.keypadClose();}catch(e){}
}
};

A._mods.push('input');

module.exports=A;
