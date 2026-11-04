


















var A=require('celeros.app');
require('celeros.app.text');

A.chat={
version:'1.0.0',


new:function(o){
o=o||{};
var T=A.T||System.theme();
var W=240;
var q=o.pad||8;
var t={
view:[],
busy:false,
max:o.max||60,
bw:o.bw||180,
top:o.top===undefined?4:o.top,
height:0
};

function p(k,s,G){
s=A.text.fit(s);
var n={k:k,s:s,c:G};
if(k==='note'){
n.h=UI.measureWrap(s,W-24,'caption');
}else{
var D=UI.measure(s,'body')+2*q;
n.bw=D<t.bw?Math.max(D,40):t.bw;
n.h=UI.measureWrap(s,n.bw-2*q,'body')+12;
}
t.view.push(n);
if(t.view.length>t.max)t.view.shift();
UI.scrollTo('kit:chat',1e6);
}

t.push=p;
t.user=function(s){p('user',s);};
t.bot=function(s){p('assistant',s);};
t.note=function(s,w){p('note',s,w===undefined?T.textDim:w);};
t.err=function(s){p('note',s,T.err);};
t.clear=function(){t.view=[];UI.invalidate();};



t.draw=function(u,h){
var y=t.top+6;
var i,b;
for(i=0;i<t.view.length;i++)y+=t.view[i].h+8;
if(t.busy)y+=36;
var r=y;
t.height=r;
var m=h||(320-t.top-44);
var C=UI.scrollBegin('kit:chat',0,t.top,W,m,Math.max(m,r));


if(typeof __harness!=='undefined'){
__harness.chatOff=C;
__harness.chatMax=Math.max(0,r-m);
}
y=t.top+6-C;
for(i=0;i<t.view.length;i++){
b=t.view[i];
var E=y+b.h>=t.top&&y<t.top+m;
if(b.k==='note'){
if(u&&E){
UI.text(b.s,W/2,y,{role:'caption',align:'center',
color:b.c,w:W-24,lines:64,id:i});
}
}else{
var B=b.k==='user';
var x=B?W-8-b.bw:8;
var v=B?T.accentD:T.raised;
if(u&&E){
System.fillRoundRect(x,y,b.bw,b.h,12,v);
UI.text(b.s,x+q,y+6,{w:b.bw-2*q,lines:64,bg:v,id:i});
}
}
y+=b.h+8;
}
if(t.busy){
if(u)System.fillRoundRect(8,y,64,28,12,T.raised);
UI.spinner(40,y+14,9);
}else if(!t.view.length&&u){
UI.text('Sem mensagens',W/2,t.top+m/2-8,
{role:'caption',align:'center',color:T.textDim});
}
UI.scrollEnd();
return r;
};

return t;
}
};

A._mods.push('chat');

module.exports=A;
