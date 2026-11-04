



















var A=require('celeros.app');
var S=System;

A.rows={
version:'1.0.3',


formRow:function(r,x,y,w,h,st){
if(!r||!r.k)return;
var T=(A.style&&A.style.T)||A.T||S.theme()||{};
var E=r.k==='info'||r.k==='secao';
var m=UI.lineHeight('body');
var l=UI.lineHeight('caption');
var G=r.k==='toggle'?50
:r.k==='gauge'?88
:r.k==='stepper'?112
:(r.k==='choice'||r.k==='picker'||r.k==='info')?120
:0;
var n=w-8-G;
if(n<8)n=8;


var C=y+Math.round((h-(r.sub?m+1+l:m))/2);
UI.text(String(r.label===undefined?'':r.label),x,C,
{role:'body',color:E?T.textDim:T.text,w:n,lines:1});
if(r.sub){
UI.text(String(r.sub),x,C+m+1,
{role:'caption',color:T.textDim,w:n,lines:1});
}
if(r.k==='toggle'){
var B=!!r.get();
var z=UI.toggle(x+w-44,y+Math.round((h-24)/2),B);
if(z!==B)r.set(z);
}else if(r.k==='gauge'){
var F=r.get();
var f=(F-r.min)/(r.max-r.min);
if(!(f>=0))f=0;
if(f>1)f=1;
var t=x+w-84,u=y+Math.round(h/2)-4;
S.fillRoundRect(t,u,76,8,4,T.card);
if(f>.01){
S.fillRoundRect(t,u,Math.max(2,Math.round(76*f)),8,4,
r.color===undefined?T.accent:r.color);
}
}else if(r.k==='stepper'){
var o=r.get();




if(UI.button('-',x+w-108,y+2,28,h-4,{style:'ghost'})){
var q=o-r.step;
if(q<r.min)q=r.min;
r.set(q);
}
if(UI.button('+',x+w-32,y+2,28,h-4,{style:'ghost'})){
var s=o+r.step;
if(s>r.max)s=r.max;
r.set(s);
}



UI.text(String(r.fmt?r.fmt(o):o),x+w-56,
y+Math.round((h-m)/2),
{role:'body',align:'center',color:T.text,w:44,lines:1});
}else if(r.k==='choice'){


var j=r.opts||[],D=r.get()|0;
var v=j.length?((D%j.length)+j.length)%j.length:0;
UI.text(String(j[v]===undefined?'':j[v]),x+w-8,
y+Math.round((h-l)/2),
{role:'caption',align:'right',color:T.textDim,
w:112,lines:1});
}else if(r.k==='picker'){
UI.text(String(r.items[r.get()]||''),x+w-8,
y+Math.round((h-l)/2),
{role:'caption',align:'right',color:T.textDim,
w:112,lines:1});
}else if(r.k==='info'){
UI.text(String(r.right),x+w-8,y+Math.round((h-l)/2),
{role:'caption',align:'right',
color:r.rightColor===undefined?T.textDim:r.rightColor,
w:112,lines:1});
}
}
};

A._mods.push('rows');

module.exports=A;
