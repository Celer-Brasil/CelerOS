




























var G=require('celeros.gamepad');

var b={version:'0.1.0'};

var B=1,aa=7,ua=9;
var ba=48,ca=49,va=56;



function s(Ca,f){
var v=0;
for(var k=0;k<f.bits;k++){
var fa=Ca[(f.off+k)>>3];
if(fa===undefined)return null;
if(((fa>>((f.off+k)&7))&1)!==0)v+=Math.pow(2,k);
}
return v;
}


function Y(N,f){
if(N===null)return 0;
if(f.min<0&&N>=Math.pow(2,f.bits-1))return N-Math.pow(2,f.bits);
return N;
}



function la(ia,Fa){
var da=null,ea=0,J,i;
for(J in ia.reports){
if(J.indexOf('|in')<0)continue;
var S=ia.reports[J],n=0;
for(i=0;i<S.length;i++){
if(Fa(S[i]))n++;
}
if(n>ea){
ea=n;
da={id:parseInt(J.split('|')[0],10)||0,fields:S};
}
}
return da;
}






b.keyboard=function(U){
if(!U||U.length===0)return null;
var za=G.parseMap(U);
var h=la(za,function(f){return f.page===aa;});
if(!h)return null;
var L=[],O=[],i,f;
for(i=0;i<h.fields.length;i++){
f=h.fields[i];
if(f.page!==aa)continue;
if(f.bits===1&&f.usage>=224&&f.usage<=231)L.push(f);
else if(f.bits>=8)O.push(f);
}
if(O.length===0)return null;
var z=[];
return{
id:h.id,
accepts:function(Da){return h.id===0||Da===h.id;},
feed:function(r){
if(!r||!(h.id===0||r.id===h.id))return null;
var m=0,o=[],a,v;
for(a=0;a<L.length;a++){
if(s(r.data,L[a]))m|=(1<<(L[a].usage-224));
}
for(a=0;a<O.length;a++){
v=s(r.data,O[a]);
if(v)o.push(v);
}
var ma=[],pa=[];
for(a=0;a<o.length;a++){
if(z.indexOf(o[a])<0)ma.push(o[a]);
}
for(a=0;a<z.length;a++){
if(o.indexOf(z[a])<0)pa.push(z[a]);
}
z=o;
return{mods:m,keys:o,pressed:ma,released:pa};
}
};
};



b.mouse=function(V){
if(!V||V.length===0)return null;
var Aa=G.parseMap(V);
var j=la(Aa,function(f){
return f.page===B&&(f.usage===ba||f.usage===ca);
});
if(!j)return null;
var w=null,x=null,E=null,D=[],i,f;
for(i=0;i<j.fields.length;i++){
f=j.fields[i];
if(f.page===B&&f.usage===ba)w=f;
else if(f.page===B&&f.usage===ca)x=f;
else if(f.page===B&&f.usage===va)E=f;
else if(f.page===ua&&f.bits===1&&f.usage>=1&&f.usage<=8)D.push(f);
}
if(w===null&&x===null)return null;
var oa=0;
return{
id:j.id,
accepts:function(Ea){return j.id===0||Ea===j.id;},
feed:function(r){
if(!r||!(j.id===0||r.id===j.id))return null;
var K=0,e,v;
for(e=0;e<D.length;e++){
if(s(r.data,D[e]))K|=(1<<(D[e].usage-1));
}
var na=[],qa=[];
for(e=0;e<8;e++){
var ta=(oa&(1<<e))!==0;
var ka=(K&(1<<e))!==0;
if(ka&&!ta)na.push(e+1);
if(!ka&&ta)qa.push(e+1);
}
oa=K;
return{
dx:w?Y(s(r.data,w),w):0,
dy:x?Y(s(r.data,x),x):0,
wheel:E?Y(s(r.data,E),E):0,
buttons:K,pressed:na,released:qa
};
}
};
};





b.attach=function(ja,ya){
var l=b.keyboard(ja);
var t=b.mouse(ja);
if(!l&&!t)return null;
return{
kind:ya||(l&&t?'combo':(l?'kbd':'mouse')),
keyboard:l,
mouse:t,

feed:function(r){
if(!r)return null;
var p=null;
if(l&&l.accepts(r.id)){
p=p||{};
p.kbd=l.feed(r);
}
if(t&&t.accepts(r.id)){
p=p||{};
p.mouse=t.feed(r);
}
return p;
}
};
};


b.setup=function(){
if(typeof BT==='undefined')return null;
var Z=BT.state();
if(!Z||Z.phase!=='ready')return null;
return b.attach(BT.reportMap(),Z.kind);
};




b.kindOfAppearance=function(C){
if(C===961)return'kbd';
if(C===962)return'mouse';
if(C===963||C===964)return'pad';
return'';
};


b.devices=function(){
var X=[];
if(typeof BT==='undefined')return X;
var ga=BT.scanResults();
for(var i=0;i<ga.length;i++){
var d=ga[i];
X.push({
addr:d.addr,name:d.name,rssi:d.rssi,
kind:d.kind||b.kindOfAppearance(d.appearance),
appearance:d.appearance
});
}
return X;
};

b.scan=function(ms){
if(typeof BT==='undefined')return[];
BT.scan(ms||3000);
return b.devices();
};

b.connect=function(wa){
if(typeof BT==='undefined')return{ok:false,err:'sem BT neste firmware'};
return BT.connect(wa);
};

b.disconnect=function(){
if(typeof BT==='undefined')return false;
return BT.disconnect();
};


b.device=function(){
if(typeof BT==='undefined')return null;
return BT.state();
};

b.kind=function(){
var st=b.device();
return(st&&st.kind)||'';
};

module.exports=b;
