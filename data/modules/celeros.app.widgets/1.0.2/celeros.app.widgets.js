






















var A=require('celeros.app');
require('celeros.app.style');
require('celeros.app.icons');
var S=System;

function da(a,b,t){
if(t<=0)return a;
if(t>=1)return b;
var r1=(a>>11)&31,g1=(a>>5)&63,b1=a&31;
var r2=(b>>11)&31,g2=(b>>5)&63,b2=b&31;
return(Math.round(r1+(r2-r1)*t)<<11)|
(Math.round(g1+(g2-g1)*t)<<5)|
Math.round(b1+(b2-b1)*t);
}

var N=false;
var Y=false;
var ya={};

function gb(){
var t=UI.touch();
if(!t.tap)N=false;
return t;
}
function ua(x,y,w,h){
var t=gb();
if(!t.tap||N)return false;
if(t.x>=x&&t.x<=x+w&&t.y>=y&&t.y<=y+h){
N=true;
return true;
}
return false;
}
function Ia(x,y,w,h){
var t=UI.touch();
return t.down&&t.x>=x&&t.x<=x+w&&t.y>=y&&t.y<=y+h;
}

A.widgets={
version:'1.0.2',







button:function(qa,x,y,w,h,o){
o=o||{};
var T=A.style.T;
var aa=!!o.disabled;
var v=o.variant;
var $=aa?T.card
:o.bg!==undefined?o.bg
:v==='danger'?T.err
:v==='success'?T.ok
:v==='secondary'?T.raised
:v==='ghost'?T.card:T.accent;
var fg=aa?T.textDim
:o.textColor!==undefined?o.textColor
:v==='danger'?65535
:v==='success'?0
:v==='ghost'?T.accent
:v==='secondary'?T.text:T.onAccent;
var on=!aa&&Ia(x,y,w,h);
if(on!==Y){Y=on;UI.invalidate();}
UI.card(x,y,w,h,{
color:on?da($,0,.15):$,
radius:o.r===undefined?T.radius:o.r,
stroke:o.stroke===true
});
var G=Math.round(Math.min(h*.5,18));
var lh=UI.lineHeight(o.role||'body');
if(o.icon&&qa){
A.icons.draw(o.icon,x+8,Math.round(y+(h-G)/2),G,{color:fg});
UI.text(qa,x+8+G+6,Math.round(y+(h-lh)/2),
{role:o.role||'body',color:fg,bg:$,
w:w-8-G-14,lines:1});
}else if(o.icon){
A.icons.draw(o.icon,x+Math.round((w-G)/2),
Math.round(y+(h-G)/2),G,{color:fg});
}else{
UI.text(qa,x+w/2,Math.round(y+(h-lh)/2),
{role:o.role||'body',align:'center',color:fg,
bg:$,w:w-16,lines:1});
}
UI.cardEnd();
return!aa&&ua(x,y,w,h);
},

iconButton:function($a,x,y,C,o){
o=o||{};
var T=A.style.T;
var bg=o.bg===undefined?T.raised:o.bg;
var fg=o.color===undefined?T.text:o.color;
var on=!o.disabled&&Ia(x,y,C,C);
if(on!==Y){Y=on;UI.invalidate();}
UI.card(x,y,C,C,{
color:on?da(bg,0,.15):bg,
radius:o.r===undefined?Math.round(C/2):o.r,
stroke:false
});
A.icons.draw($a,x+Math.round((C-16)/2),
y+Math.round((C-16)/2),16,{color:fg});
UI.cardEnd();
return!o.disabled&&ua(x,y,C,C);
},


header:function(fb,o){
o=o||{};
var T=A.style.T;
var h=o.h===undefined?40:o.h;
var L=o.bg===undefined?T.card:o.bg;
var la=o.back!==false;
var ka=o.actions||[];
var n=ka.length;
var O=h-12;
var Aa=4;
var aw=n?n*(O+Aa)+8:0;
UI.card(0,0,240,h,{color:L,radius:0,stroke:false});
if(o.full){
if(T.grad)S.fillGradient(0,0,240,h,da(L,65535,.05),L,0);
S.fillRect(0,h-1,240,1,T.stroke);
}
if(la)A.icons.draw('back',6,Math.round((h-18)/2),18,{color:T.accent});
var tx=la?30:8;
UI.text(fb,tx,Math.round((h-UI.lineHeight('title'))/2),
{role:'title',color:T.text,bg:L,w:240-tx-aw-8,lines:1});
if(o.sub&&!n){
UI.text(o.sub,232,Math.round((h-UI.lineHeight('caption'))/2),
{role:'caption',align:'right',color:T.textDim,bg:L,
w:120,lines:1});
}
var za=null;
for(var i=0;i<n;i++){
var ax=240-8-O-(n-1-i)*(O+Aa);
if(A.widgets.iconButton(ka[i].icon,ax,Math.round((h-O)/2),
O,{bg:L,color:T.text})){
za=ka[i].id;
}
}
var ab=la&&ua(0,0,44,h);
UI.cardEnd();
return{back:ab,action:za};
},


ring:function(cx,cy,r,pa,o){
o=o||{};
var T=A.style.T;
var th=o.th===undefined?5:o.th;


var f=!(pa>=0)?0:(pa>1?1:pa);
S.fillArc(cx,cy,Math.max(0,r-th),r,0,360,
o.bg===undefined?T.raised:o.bg);
if(f>.005){
S.fillArc(cx,cy,Math.max(0,r-th),r,-90,-90+360*f,
o.color===undefined?T.accent:o.color);
}
if(o.label!==undefined){
S.setTextColor(o.textColor===undefined?T.text:o.textColor);
S.setTextDatum(5);
S.drawString(String(o.label),cx,cy,o.font||2);
S.setTextDatum(0);
S.setTextSize(1);
}
return f;
},



sheet:function(id,o,Da){
o=o||{};
var T=A.style.T;
id=id||'sheet';
var ta=o.open===undefined?true:!!o.open;
var s=ya[id];
if(!s)s=ya[id]={p:0,t:0};
var Ha=S.millis();
var dt=s.t?Ha-s.t:0;
s.t=Ha;
var fa=ta?1:0;
if(s.p!==fa){
var k=Math.min(1,dt/160*4);
s.p+=(fa-s.p)*k;
if(Math.abs(fa-s.p)<.02)s.p=fa;
UI.invalidate();
}
if(!ta&&s.p<=.001)return null;
var W=240,H=320;
var h=o.h===undefined?180:o.h;
var y=H-h*s.p;
if(o.full){
S.fillRect(0,0,W,H,
da(T.bg,0,(o.dim===undefined?55:o.dim)*s.p/100));
}
A.style.card(0,y,W,h,{
full:o.full,r:T.radius,grad:true,
pad:o.pad===undefined?12:o.pad,
draw:function(c){
S.fillRoundRect(W/2-20,y+6,40,3,2,T.stroke);
var M=c.y;
if(o.title){
UI.text(o.title,c.x,M,{role:'title',color:T.text,
bg:c.bg,w:c.w,lines:1});
M+=UI.lineHeight('title')+4;
A.style.divider(c.x,M-2,c.w);
M+=4;
}
if(Da)Da({x:c.x,y:M,w:c.w,h:c.y+c.h-M,bg:c.bg});
}
});
if(ta&&!N){
var t=UI.touch();
if(t.tap&&t.y<y){N=true;return'close';}
}
return null;
},


segmented:function(x,y,w,h,cb,eb){
return UI.tabs(x,y,w,h,cb,eb);
}
};

A._mods.push('widgets');

module.exports=A;
