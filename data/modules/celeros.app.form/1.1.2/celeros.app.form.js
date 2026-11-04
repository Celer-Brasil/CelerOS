































var A=require('celeros.app');
require('celeros.app.list');


function W(u){
var D=[],i,j;
for(i=0;i<u.length;i++){
if(u[i]instanceof Array){
for(j=0;j<u[i].length;j++)D.push(u[i][j]);
}else D.push(u[i]);
}
return D;
}

function ka(M){
var T=A.T||System.theme();
var g=[];
for(var i=0;i<M.length;i++){
var r=M[i];
if(!r||!r.k){g.push(r);continue;}
if(r.k==='secao')g.push({label:r.label,enabled:false});
else if(r.k==='info')g.push({label:r.label,right:r.right,
rightColor:r.rightColor||null,enabled:false});
else if(r.k==='toggle'){
var K=!!r.get();
g.push({label:r.label,right:K?'Sim':'Não',
rightColor:K?T.ok:T.textDim});
}else if(r.k==='choice'){


var v=r.get()|0;
var l=r.opts||[];
var F=l.length?((v%l.length)+l.length)%l.length:0;
g.push({label:r.label,right:l[F]===undefined?'':l[F]});
}else if(r.k==='picker'){
g.push({label:r.label,right:r.items[r.get()]||'',sub:r.sub});
}else if(r.k==='gauge'||r.k==='stepper'){
var G=r.get();
g.push({label:r.label,right:String(r.fmt?r.fmt(G):G),
enabled:false});
}else{
g.push({label:r.label,sub:r.sub});
}
}
return g;
}

A.form={
version:'1.1.2',


info:function(ba,xa,V){
return{k:'info',label:ba,right:String(xa),rightColor:V};
},
action:function(ca,U,o){
return{k:'action',label:ca,cb:U,sub:o&&o.sub};
},
toggle:function(da,X,ma){
return{k:'toggle',label:da,get:X,set:ma};
},

choice:function(ea,Y,na,ia){
return{k:'choice',label:ea,get:Y,set:na,opts:ia};
},

picker:function(fa,Z,oa,aa){
return{k:'picker',label:fa,get:Z,set:oa,items:aa};
},
secao:function(qa){return{k:'secao',label:qa};},


gauge:function(ga,_,o){
o=o||{};
return{k:'gauge',label:ga,get:_,
min:o.min===undefined?0:o.min,
max:o.max===undefined?100:o.max,
fmt:o.fmt,color:o.color};
},

stepper:function(ha,$,pa,o){
o=o||{};
return{k:'stepper',label:ha,get:$,set:pa,
min:o.min===undefined?0:o.min,
max:o.max===undefined?100:o.max,
step:o.step===undefined?1:o.step,
fmt:o.fmt};
},

card:function(ra,ja){
return[A.form.secao(ra)].concat(ja||[]);
},




run:function(sa,S){
var T=A.T||System.theme();
var m=null;
UI.resetScroll('kit:form');
for(;;){
UI.begin(T.bg);
if(UI.header(sa,{back:true}))return;
if(!m)m=W(S());
var i;
if(A.list&&A.list.view&&A.rows&&A.rows.formRow){
i=A.list.view('kit:form',A.L.x,A.L.top,A.L.w,
A.L.bottom-A.L.top,m,
{row:36,paintRow:A.rows.formRow});
}else{
i=UI.list('kit:form',A.L.x,A.L.top,A.L.w,
A.L.bottom-A.L.top,ka(m));
}
if(i>=0){
var r=m[i];
var t=false;
if(r&&r.k==='toggle'){r.set(!r.get());t=true;}
else if(r&&r.k==='stepper'){
var w=r.get()+r.step;
if(w>r.max)w=r.max;
if(w<r.min)w=r.min;
r.set(w);
}else if(r&&r.k==='choice'&&r.opts&&r.opts.length){

r.set(((r.get()|0)+1)%r.opts.length);
t=true;
}else if(r&&r.k==='picker'){
var p=A.form.pick(r.label,r.items,r.get()|0);
if(p>=0){r.set(p);t=true;}
}else if(r&&r.k==='action'&&r.cb){
t=r.cb()!==false;
}
if(t)m=null;
UI.invalidate();
}
UI.end(20);
}
},


pick:function(ta,H,la){
var T=A.T||System.theme();
var N=[];
for(var i=0;i<H.length;i++)N.push({label:H[i]});
UI.resetScroll('kit:pick');
for(;;){
UI.begin(T.bg);
if(UI.header(ta,{back:true}))return-1;
var j=UI.list('kit:pick',A.L.x,A.L.top,A.L.w,A.L.bottom-A.L.top,
N,{selected:la});
if(j>=0)return j;
UI.end(20);
}
},






askText:function(ua,o){
o=o||{};
try{
return System.prompt(ua,o.initial||'',
{hint:o.hint,mask:!!o.mask,nullOnCancel:true});
}catch(e){return null;}
},



askNum:function(va,o){
o=o||{};
var O=o.initial===undefined||o.initial===null?'':String(o.initial);
for(;;){
var s=A.form.askText(va,{hint:o.hint,initial:O});
if(s===null||s==='')return null;
O=s;
var v=parseFloat(String(s).replace(',','.'));
var R=isNaN(v)||
(o.int&&Math.round(v)!==v)||
(o.min!==undefined&&v<o.min)||
(o.max!==undefined&&v>o.max);
if(!R)return v;
A.error('Valor inválido','Digite um número'+
(o.int?' inteiro':'')+
(o.min!==undefined&&o.max!==undefined?' entre '+o.min+' e '+o.max:''));
}
}
};

A._mods.push('form');

module.exports=A;
