























var A=require('celeros.app');
var S=System;


function Y(a,b,t){
if(t<=0)return a;
if(t>=1)return b;
var r1=(a>>11)&31,g1=(a>>5)&63,$=a&31;
var r2=(b>>11)&31,g2=(b>>5)&63,b2=b&31;
var r=Math.round(r1+(r2-r1)*t);
var g=Math.round(g1+(g2-g1)*t);
var bl=Math.round($+(b2-$)*t);
return(r<<11)|(g<<5)|bl;
}
function u(r,g,b){return S.color(r,g,b);}
function Ea(){
try{return S.getInfo()||{};}catch(e){return{};}
}

var B={x:0,y:0,w:0,h:0};


var T={
preset:'soft',
bg:0,card:0,raised:0,stroke:0,accent:0,accentD:0,
onAccent:0,text:0,textDim:0,ok:0,warn:0,err:0,
radius:10,gap:8,pad:10,shadow:1,grad:true,
_src:null
};

function P(U,f,Ia){
f=f||S.theme()||{};
T.preset=U;
T.bg=f.bg===undefined?0:f.bg;
T.card=f.card===undefined?8452:f.card;
T.raised=f.raised===undefined?12678:f.raised;
T.stroke=f.stroke===undefined?16904:f.stroke;
T.accent=f.accent===undefined?2047:f.accent;
T.accentD=f.accentD===undefined?819:f.accentD;
T.onAccent=f.onAccent===undefined?0:f.onAccent;
T.text=f.text===undefined?65535:f.text;
T.textDim=f.textDim===undefined?33808:f.textDim;
T.ok=f.ok===undefined?1504:f.ok;
T.warn=f.warn===undefined?64800:f.warn;
T.err=f.err===undefined?63488:f.err;
if(U==='flat'){
T.radius=6;T.shadow=0;T.grad=false;
}else if(U==='neon'){
T.radius=12;T.shadow=2;T.grad=true;
T.bg=0;
T.card=2113;
T.raised=4258;
T.stroke=T.accent;
T.text=65535;
T.textDim=33808;
T.accentD=Y(T.accent,0,.45);
}else if(U==='paper'){
T.radius=2;T.shadow=1;T.grad=false;
T.bg=u(242,238,228);T.card=u(255,253,247);
T.raised=u(232,226,212);T.stroke=u(185,176,156);
T.text=u(28,27,24);T.textDim=u(107,100,89);
T.accent=u(47,111,237);T.accentD=u(29,79,184);
T.onAccent=65535;T.ok=u(46,158,91);
T.warn=u(217,138,0);T.err=u(198,53,47);
}else{
T.radius=10;T.shadow=2;T.grad=true;
}
T._src=f;
if(Ia)UI.invalidate();
}

function z(){
if(A.T&&T._src!==A.T)P(T.preset||'soft',A.T,true);
}


function Na(x,y,w,h,r,n,bg){
for(var i=n;i>=1;i--){
var e=i*2;
S.fillSmoothRoundRect(x-e,y-e+2,w+e*2,h+e*2,r+e,
Y(bg,0,.12*i));
}
}


A.style={
version:'1.1.1',
T:T,


full:!!(UI.extras&&UI.custom),

preset:function(Ga){
P(Ga||'soft',A.T||S.theme(),true);
return T;
},
reset:function(){
P('soft',A.T||S.theme(),true);
return T;
},


inset:function(){return Ea().inset||0;},


content:function(ja,aa){
z();
var L=A.L||{x:8,w:224,top:48,bottom:312};
var y=ja===undefined?L.top:ja;
var b=aa===undefined?L.bottom:aa;
return{x:L.x,y:y,w:L.w,h:b-y};
},


stack:function(x,y,w,o){
z();
o=o||{};
var j={
x:x,y:y,w:w,dir:o.dir||'v',
gap:o.gap===undefined?T.gap:o.gap,
cursor:0
};
j.next=function(h,ww){
B.x=j.dir==='h'?j.x+j.cursor:j.x;
B.y=j.dir==='h'?j.y:j.y+j.cursor;
B.w=ww===undefined?j.w:ww;
B.h=h;
j.cursor+=(j.dir==='h'?B.w:h)+j.gap;
return B;
};
j.reset=function(){j.cursor=0;};
j.end=function(){return j.cursor>0?j.cursor-j.gap:0;};
return j;
},


icon:function(Ha,x,y,_,o){
z();
if(A.icons)return A.icons.draw(Ha,x,y,_,o);
var s=_===undefined?16:_;
var c=(o&&o.color!==undefined)?o.color:T.text;
S.fillCircle(x+s/2,y+s/2,Math.max(1,s/5),c);
},



card:function(x,y,w,h,o){
z();
o=o||{};
var W=o.pad===undefined?T.pad:o.pad;
var r=o.r===undefined?T.radius:o.r;
var D=o.bg===undefined?T.card:o.bg;
var ia=o.stroke!==false;
if(o.full){
var el=o.elev===undefined?T.shadow:o.elev;
if(el>0)Na(x,y,w,h,r,el,D);
}
UI.card(x,y,w,h,{color:D,radius:r,stroke:ia});




if(o.full&&(o.grad===undefined?(T.grad&&!o.draw):o.grad)){
S.fillGradient(x,y,w,h,Y(D,65535,.06),D,r);
if(ia)S.drawRoundRect(x,y,w,h,r,T.stroke);
}
var cr={x:x+W,y:y+W,w:w-W*2,h:h-W*2,bg:D};
if(typeof o.draw==='function'){
o.draw(cr);
UI.cardEnd();
}
return cr;
},
cardEnd:function(){UI.cardEnd();},




custom:function(id,x,y,w,h,Oa,xa,o){
z();
o=o||{};
return A.custom(id,x,y,w,h,Oa,xa,
{bg:o.bg===undefined?T.card:o.bg,clear:o.clear});
},

divider:function(x,y,w,o){
z();
o=o||{};
S.fillRect(x,y,w,o.h===undefined?1:o.h,
o.color===undefined?T.stroke:o.color);
},




button:function(ga,x,y,w,h,o){
z();
o=o||{};
if(o.icon&&A.widgets&&A.widgets.button){
return A.widgets.button(ga,x,y,w,h,o);
}
var v=o.variant||(o.primary===false?'secondary':'primary');
var st=v==='ghost'?'ghost'
:v==='danger'?'danger':'primary';
var m={style:st,disabled:!!o.disabled,role:o.role||'body'};
if(o.color!==undefined)m.color=o.color;
else if(v==='primary')m.color=T.accent;
else if(v==='danger')m.color=T.err;
else if(v==='success')m.color=T.ok;
else if(v==='secondary')m.color=T.raised;
if(o.textColor!==undefined)m.textColor=o.textColor;
else if(v==='primary')m.textColor=T.onAccent;
else if(v==='danger')m.textColor=65535;
else if(v==='success')m.textColor=0;
else if(v==='ghost')m.textColor=T.accent;
else m.textColor=T.text;
return UI.button(ga,x,y,w,h,m);
}
};

P('soft',A.T||S.theme(),false);
A._mods.push('style');

module.exports=A;
