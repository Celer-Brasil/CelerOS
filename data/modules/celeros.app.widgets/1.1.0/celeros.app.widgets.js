






















var A=require('celeros.app');
require('celeros.app.style');
require('celeros.app.icons');
var S=System;


var Y=Math.max(8,A.style.inset());

var L=false;
var R=false;
var wa={};

function _a(){
var t=UI.touch();
if(!t.tap)L=false;
return t;
}
function sa(x,y,w,h){
var t=_a();
if(!t.tap||L)return false;
if(t.x>=x&&t.x<=x+w&&t.y>=y&&t.y<=y+h){
L=true;
return true;
}
return false;
}
function Da(x,y,w,h){
var t=UI.touch();
return t.down&&t.x>=x&&t.x<=x+w&&t.y>=y&&t.y<=y+h;
}

A.widgets={
version:'1.1.0',







button:function(na,x,y,w,h,o){
o=o||{};
var T=A.style.T;
var V=!!o.disabled;
var v=o.variant;
var U=V?T.card
:o.bg!==undefined?o.bg
:v==='danger'?T.err
:v==='success'?T.ok
:v==='secondary'?T.raised
:v==='ghost'?T.card:T.accent;
var X=V?T.textDim
:o.textColor!==undefined?o.textColor
:v==='danger'?65535
:v==='success'?0
:v==='ghost'?T.accent
:v==='secondary'?T.text:T.onAccent;
var on=!V&&Da(x,y,w,h);
if(on!==R){R=on;UI.invalidate();}
UI.card(x,y,w,h,{
color:on?S.mixColor(U,0,15):U,
radius:o.r===undefined?T.radius:o.r,
stroke:o.stroke===true
});
var E=Math.round(Math.min(h*.5,18));
var lh=UI.lineHeight(o.role||'body');
if(o.icon&&na){
A.icons.draw(o.icon,x+8,Math.round(y+(h-E)/2),E,{color:X});
UI.text(na,x+8+E+6,Math.round(y+(h-lh)/2),
{role:o.role||'body',color:X,bg:U,
w:w-8-E-14,lines:1});
}else if(o.icon){
A.icons.draw(o.icon,x+Math.round((w-E)/2),
Math.round(y+(h-E)/2),E,{color:X});
}else{
UI.text(na,x+w/2,Math.round(y+(h-lh)/2),
{role:o.role||'body',align:'center',color:X,
bg:U,w:w-16,lines:1});
}
UI.cardEnd();
return!V&&sa(x,y,w,h);
},

iconButton:function(Ua,x,y,z,o){
o=o||{};
var T=A.style.T;
var bg=o.bg===undefined?T.raised:o.bg;
var fg=o.color===undefined?T.text:o.color;
var on=!o.disabled&&Da(x,y,z,z);
if(on!==R){R=on;UI.invalidate();}
UI.card(x,y,z,z,{
color:on?S.mixColor(bg,0,15):bg,
radius:o.r===undefined?Math.round(z/2):o.r,
stroke:false
});
A.icons.draw(Ua,x+Math.round((z-16)/2),
y+Math.round((z-16)/2),16,{color:fg});
UI.cardEnd();
return!o.disabled&&sa(x,y,z,z);
},


header:function(Za,o){
o=o||{};
var T=A.style.T;
var h=o.h===undefined?40:o.h;
var J=o.bg===undefined?T.card:o.bg;
var ia=o.back!==false;
var ga=o.actions||[];
var n=ga.length;
var M=h-12;
var ha=4;
var ra=240-Y;
var tx=Y+(ia?22:0);
var Ea=ra-tx;
var aa=o.sub&&!n?Math.min(UI.measure(o.sub,'caption'),Math.floor(Ea/2)):0;
var Ia=Ea-n*(M+ha)-(aa?aa+ha:0);
UI.card(0,0,240,h,{color:J,radius:0,stroke:false});
if(o.full){
if(T.grad)S.fillGradient(0,0,240,h,S.mixColor(J,65535,5),J,0);
S.fillRect(0,h-1,240,1,T.stroke);
}
if(ia)A.icons.draw('back',Y-2,Math.round((h-18)/2),18,{color:T.accent});
if(Ia>0)UI.text(Za,tx,Math.round((h-UI.lineHeight('title'))/2),
{role:'title',color:T.text,bg:J,w:Ia,lines:1});
if(aa){
UI.text(o.sub,ra,Math.round((h-UI.lineHeight('caption'))/2),
{role:'caption',align:'right',color:T.textDim,bg:J,
w:aa,lines:1});
}
var xa=null;
for(var i=0;i<n;i++){
var ax=ra-M-(n-1-i)*(M+ha);
if(A.widgets.iconButton(ga[i].icon,ax,Math.round((h-M)/2),
M,{bg:J,color:T.text})){
xa=ga[i].id;
}
}
var Va=ia&&sa(0,0,Y+36,h);
UI.cardEnd();
return{back:Va,action:xa};
},


ring:function(cx,cy,r,ma,o){
o=o||{};
var T=A.style.T;
var th=o.th===undefined?5:o.th;


var f=!(ma>=0)?0:(ma>1?1:ma);
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



sheet:function(Z,o,za){
o=o||{};
var T=A.style.T;
Z=Z||'sheet';
var qa=o.open===undefined?true:!!o.open;
var s=wa[Z];
if(!s)s=wa[Z]={p:0,t:0};
var Ca=S.millis();
var dt=s.t?Ca-s.t:0;
s.t=Ca;
var ba=qa?1:0;
if(s.p!==ba){
var k=Math.min(1,dt/160*4);
s.p+=(ba-s.p)*k;
if(Math.abs(ba-s.p)<.02)s.p=ba;
UI.invalidate();
}
if(!qa&&s.p<=.001)return null;
var W=240,H=320;
var h=o.h===undefined?180:o.h;
var y=H-h*s.p;
if(o.full){
S.fillRect(0,0,W,H,
S.mixColor(T.bg,0,Math.round((o.dim===undefined?55:o.dim)*s.p)));
}
A.style.card(0,y,W,h,{
full:o.full,r:T.radius,grad:true,
pad:o.pad===undefined?12:o.pad,
draw:function(c){
S.fillRoundRect(W/2-20,y+6,40,3,2,T.stroke);
var K=c.y;
if(o.title){
UI.text(o.title,c.x,K,{role:'title',color:T.text,
bg:c.bg,w:c.w,lines:1});
K+=UI.lineHeight('title')+4;
A.style.divider(c.x,K-2,c.w);
K+=4;
}
if(za)za({x:c.x,y:K,w:c.w,h:c.y+c.h-K,bg:c.bg});
}
});
if(qa&&!L){
var t=UI.touch();
if(t.tap&&t.y<y){L=true;return'close';}
}
return null;
},


segmented:function(x,y,w,h,Xa,Ya){
return UI.tabs(x,y,w,h,Xa,Ya);
}
};

A._mods.push('widgets');

module.exports=A;
