


























var A=require('celeros.app');
var g=require('celeros.mesh');

A.mesh={
version:'1.0.1',
_fam:'a',
_seq:0,
_pend:{},
_seen:[],
_cache:{},


family:function(H){A.mesh._fam=String(H).charAt(0)||'a';},


available:function(){return g.available();},
active:function(){return g.active();},
gate:function(M,o){return g.gate(M,o);},
me:function(){return g.me();},
nodes:function(){
try{return CelerNet.nodes();}catch(e){return[];}
},



send:function(T,O,Q,o){
var s=A.mesh._fam+O+(Q||'');
try{
if(o&&o.ttl!==undefined)return!!CelerNet.broadcast(s,o.ttl);
return!!CelerNet.send(T,s,o||{copies:1});
}catch(e){return false;}
},






req:function(U,P,R,x,S){
var K=S||4000;

var F=(A.mesh._seq=(A.mesh._seq+1)%1296);
var w='0123456789abcdefghijklmnopqrstuvwxyz';
var i=w.charAt(Math.floor(F/36))+w.charAt(F%36);
A.mesh._pend[i]={fn:x};
setTimeout(function(){
var p=A.mesh._pend[i];
if(p&&p.fn){
p.fn=null;
delete A.mesh._pend[i];
x(null,null);
}
},K);
return A.mesh.send(U,P,(R||'')+i,{copies:1});
},


_fresh:function(n){
var s=A.mesh._seen;
if(s.indexOf(n)>=0)return false;
s.push(n);
if(s.length>32)s.shift();
return true;
},










each:function(t){
var n=0,m;
while((m=CelerNet.poll())!==null){
n++;
var h=String(m.msg===undefined||m.msg===null?'':m.msg);
if(h.charAt(0)!==A.mesh._fam){
t(m.from,'',h,m);
continue;
}
var D=h.charAt(1);
var f=h.substring(2);
if(D==='='){
var j=f.substring(0,2);
var p=A.mesh._pend[j];
if(p&&p.fn&&A.mesh._fresh(j)){
var J=p.fn;
p.fn=null;
delete A.mesh._pend[j];
J(f.length>3?f.substring(3):'',m.from);
}else if(!p&&A.mesh._fresh(j)){
t(m.from,'=',f,m);
}
continue;
}
t(m.from,D,f,m);
}
return n;
},



cache:function(k,L,I){
var c=A.mesh._cache[k];
var C=System.millis();
if(c&&(C-c.at)<L)return c.v;
var v=I();
A.mesh._cache[k]={at:C,v:v};
return v;
}
};

A._mods.push('mesh');

module.exports=A;
