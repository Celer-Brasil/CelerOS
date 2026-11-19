





























var A=require('celeros.app');

A.list={
version:'1.2.0',



make:function(ua,pa){
var C=null;
return{
rows:function(){
var ja=ua();
if(C&&C.stamp===ja)return C.rows;
C={stamp:ja,rows:pa()||[]};
return C.rows;
},
drop:function(){C=null;}
};
},



sort:function(r,za,ta){
var n=r.length;
var v=new Array(n);
for(var i=0;i<n;i++)v[i]=String(za(r[i]));



for(var a=1;a<n;a++){
var it=r[a],k=v[a];
var b=a-1;
while(b>=0&&(ta?v[b]<k:v[b]>k)){
v[b+1]=v[b];
r[b+1]=r[b];
b--;
}
v[b+1]=k;
r[b+1]=it;
}
return r;
},


badge:function(U){
var T=A.T||System.theme();
return U==='ok'?T.ok:
U==='warn'?T.warn:
U==='err'?T.err:T.textDim;
},


bars:function(D){
if(typeof D!=='number'||D>=0)return-1;
if(D>-55)return 4;
if(D>-67)return 3;
if(D>-78)return 2;
if(D>-88)return 1;
return 0;
},









view:function(id,x,y,w,h,s,o){
o=o||{};
var S=System;
var T=(A.style&&A.style.T)||A.T||S.theme()||{};
var e=o.row===undefined?36:o.row;
if(e<1)e=1;
var V=UI.lineHeight('body');
var M=UI.lineHeight('caption');
var _=V+1+M;




if(e<_+2){
for(var z=0;z<s.length;z++){
if(s[z]&&typeof s[z]==='object'&&s[z].sub){
e=_+2;
break;
}
}
}
var Y=o.pad===undefined?6:o.pad;
var ia=o.panel!==false;
var Aa=o.panelBg===undefined?T.card:o.panelBg;
var Ca=o.rowBg===undefined?T.raised:o.rowBg;
var q=Math.max(1,Math.min(o.columns|0,Math.floor((w-2*Y+4)/24)));
var sa=Math.ceil(s.length/q)*e;
var P=-1;
if(ia){
UI.card(x,y,w,h,{
color:Aa,
radius:o.r===undefined?(T.radius===undefined?10:T.radius):o.r,
stroke:o.stroke!==false
});
}
var ga=x+Y,O=y+2;
var aa=w-Y*2,Z=h-4;
var X=UI.scrollBegin(id||'kit:list',ga,O,aa,Z,sa);
var k0=Math.floor(X/e)*q;
var k1=Math.min(s.length-1,Math.ceil((X+Z)/e)*q-1);
for(var k=k0;k<=k1;k++){
var c=s[k];
if(c===undefined)continue;
var Q=typeof c==='string';
var da=k%q;
var ka=Math.floor(da*(aa+4)/q);
var g=ga+ka,m=Math.floor((da+1)*(aa+4)/q)-ka-4;
var f=O+Math.floor(k/q)*e-X;
if(!Q&&(c.section||c.header||c.k==='secao')){
UI.text(String(c.label===undefined?c.section:c.label).toUpperCase(),
g+8,f+Math.round((e-M)/2),
{role:'caption',color:T.textDim,w:m-16,lines:1});
continue;
}
var G=!Q&&!!c.disabled;
var I=UI.touch();
var Ba=!G&&I.down&&I.x>=g&&I.x<=g+m&&
I.y>=f&&I.y<=f+e;
UI.card(g,f+1,m,e-2,{
color:G?T.card:Ca,
radius:o.rowR===undefined?8:o.rowR,
stroke:false
});
if(Q)c={label:c};
if(o.paintRow){
o.paintRow(c,g+8,f,m-16,e,
{pressed:Ba,disabled:G,selected:k===o.selected});
}else{
var ea=G?T.textDim
:(c.color===undefined?T.text:c.color);
var J=g+8;
if(c.icon&&A.icons){
A.icons.draw(c.icon,J,f+Math.round((e-16)/2),16,
{color:ea});
J+=22;
}
var H=0;
if(c.right!==undefined)H=UI.measure(String(c.right),'caption')+10;
else if(c.badge!==undefined)
H=UI.measure(String(c.badge),'caption')+22;
else if(c.bars>=0)H=26;
var lw=m-(J-g)-8-H;
var la=c.sub!==undefined&&c.sub!=='';


var ty=f+Math.round((e-(la?_:V))/2);
UI.text(String(c.label===undefined?'':c.label),J,ty,
{role:'body',color:ea,w:lw,lines:1});
if(la){
UI.text(String(c.sub),J,ty+V+1,
{role:'caption',color:T.textDim,w:lw,lines:1});
}
if(c.right!==undefined){
UI.text(String(c.right),g+m-8,
f+Math.round((e-M)/2),
{role:'caption',align:'right',
color:c.rightColor===undefined?T.textDim:c.rightColor,
w:H,lines:1});
}else if(c.badge!==undefined){
UI.badge(String(c.badge),
g+m-8-Math.round(UI.measure(String(c.badge),'caption')+14),
f+Math.round((e-(M+6))/2),
{color:c.badgeColor});
}else if(c.bars>=0){
var bx=g+m-8-23,by=f+Math.round((e-14)/2);
for(var F=0;F<4;F++){
var bh=4+F*3;
S.fillRect(bx+F*5,by+14-bh,3,bh,
F<c.bars?(c.rightColor===undefined?T.ok:c.rightColor)
:T.stroke);
}
}
}
if(o.widget)o.widget(c,g,f,m,e);
UI.cardEnd();
var t=UI.touch();
if(t.tap&&P<0&&t.x>=g&&t.x<g+m&&
t.y>=O&&t.y<O+Z&&t.y>=f&&t.y<f+e&&!G)P=k;
}
UI.scrollEnd();
if(ia)UI.cardEnd();
return P;
}
};

A._mods.push('list');

module.exports=A;
