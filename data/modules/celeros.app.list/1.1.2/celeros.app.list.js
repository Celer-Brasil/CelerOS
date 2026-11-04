





























var A=require('celeros.app');

A.list={
version:'1.1.2',



make:function(pa,ja){
var u=null;
return{
rows:function(){
var ca=pa();
if(u&&u.stamp===ca)return u.rows;
u={stamp:ca,rows:ja()||[]};
return u.rows;
},
drop:function(){u=null;}
};
},



sort:function(q,ua,oa){
var n=q.length;
var s=new Array(n);
for(var i=0;i<n;i++)s[i]=String(ua(q[i]));



for(var a=1;a<n;a++){
var it=q[a],k=s[a];
var b=a-1;
while(b>=0&&(oa?s[b]<k:s[b]>k)){
s[b+1]=s[b];
q[b+1]=q[b];
b--;
}
s[b+1]=k;
q[b+1]=it;
}
return q;
},


badge:function(P){
var T=A.T||System.theme();
return P==='ok'?T.ok:
P==='warn'?T.warn:
P==='err'?T.err:T.textDim;
},


bars:function(B){
if(typeof B!=='number'||B>=0)return-1;
if(B>-55)return 4;
if(B>-67)return 3;
if(B>-78)return 2;
if(B>-88)return 1;
return 0;
},









view:function(id,x,y,w,h,r,o){
o=o||{};
var S=System;
var T=(A.style&&A.style.T)||A.T||S.theme()||{};
var e=o.row===undefined?36:o.row;
if(e<1)e=1;
var Q=UI.lineHeight('body');
var ma=UI.lineHeight('caption');
var V=Q+1+ma;




if(e<V+2){
for(var z=0;z<r.length;z++){
if(r[z]&&typeof r[z]==='object'&&r[z].sub){
e=V+2;
break;
}
}
}
var $=o.pad===undefined?6:o.pad;
var aa=o.panel!==false;
var va=o.panelBg===undefined?T.card:o.panelBg;
var xa=o.rowBg===undefined?T.raised:o.rowBg;
var na=r.length*e;
var M=-1;
if(aa){
UI.card(x,y,w,h,{
color:va,
radius:o.r===undefined?(T.radius===undefined?10:T.radius):o.r,
stroke:o.stroke!==false
});
}
var f=x+$,sy=y+2;
var l=w-$*2,sh=h-4;
var U=UI.scrollBegin(id||'kit:list',f,sy,l,sh,na);
var k0=Math.floor(U/e);
var k1=Math.min(r.length-1,Math.ceil((U+sh)/e)-1);
for(var k=k0;k<=k1;k++){
var c=r[k];
if(c===undefined)continue;
var N=typeof c==='string';
var g=sy+k*e-U;
if(!N&&(c.section||c.header||c.k==='secao')){
UI.text(String(c.label===undefined?c.section:c.label).toUpperCase(),
f+8,g+Math.round((e-UI.lineHeight('caption'))/2),
{role:'caption',color:T.textDim,w:l-16,lines:1});
continue;
}
var E=!N&&!!c.disabled;
var H=UI.touch();
var wa=!E&&H.down&&H.x>=f&&H.x<=f+l&&
H.y>=g&&H.y<=g+e;
UI.card(f,g+1,l,e-2,{
color:E?T.card:xa,
radius:o.rowR===undefined?8:o.rowR,
stroke:false
});
if(N)c={label:c};
if(o.paintRow){
o.paintRow(c,f+8,g,l-16,e,
{pressed:wa,disabled:E,selected:k===o.selected});
}else{
var Y=E?T.textDim
:(c.color===undefined?T.text:c.color);
var I=f+8;
if(c.icon&&A.icons){
A.icons.draw(c.icon,I,g+Math.round((e-16)/2),16,
{color:Y});
I+=22;
}
var F=0;
if(c.right!==undefined)F=UI.measure(String(c.right),'caption')+10;
else if(c.badge!==undefined)
F=UI.measure(String(c.badge),'caption')+22;
else if(c.bars>=0)F=26;
var _=l-(I-f)-8-F;
var da=c.sub!==undefined&&c.sub!=='';


var ty=g+Math.round((e-(da?V:Q))/2);
UI.text(String(c.label===undefined?'':c.label),I,ty,
{role:'body',color:Y,w:_,lines:1});
if(da){
UI.text(String(c.sub),I,ty+Q+1,
{role:'caption',color:T.textDim,w:_,lines:1});
}
if(c.right!==undefined){
UI.text(String(c.right),f+l-8,
g+Math.round((e-UI.lineHeight('caption'))/2),
{role:'caption',align:'right',
color:c.rightColor===undefined?T.textDim:c.rightColor,
w:F,lines:1});
}else if(c.badge!==undefined){
UI.badge(String(c.badge),
f+l-8-Math.round(UI.measure(String(c.badge),'caption')+14),
g+Math.round((e-(UI.lineHeight('caption')+6))/2),
{color:c.badgeColor});
}else if(c.bars>=0){
var bx=f+l-8-23,by=g+Math.round((e-14)/2);
for(var D=0;D<4;D++){
var X=4+D*3;
S.fillRect(bx+D*5,by+14-X,3,X,
D<c.bars?(c.rightColor===undefined?T.ok:c.rightColor)
:T.stroke);
}
}
}
if(o.widget)o.widget(c,f,g,l,e);
UI.cardEnd();
var t=UI.touch();
if(t.tap&&M<0&&t.x>=f&&t.x<=f+l&&
t.y>=g&&t.y<=g+e&&!E)M=k;
}
UI.scrollEnd();
if(aa)UI.cardEnd();
return M;
}
};

A._mods.push('list');

module.exports=A;
