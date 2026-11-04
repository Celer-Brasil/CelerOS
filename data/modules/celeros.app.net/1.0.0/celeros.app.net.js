

















var A=require('celeros.app');

A.net={
version:'1.0.0',


online:function(){
try{return!!Net.isConnected();}catch(e){return false;}
},


getJSON:function(w){
try{return Net.getJSON(w);}catch(e){return null;}
},
getText:function(x){
try{return Net.get(x);}catch(e){return null;}
},
post:function(y,p,s){
try{return Net.post(y,p,s);}catch(e){return null;}
},






retry:function(k,o){
o=o||{};
var n=typeof o.n==='number'?o.n:2;
var m=typeof o.backoff==='number'?o.backoff:1500;
var r=o.ok||function(v){return v!==null&&v!==undefined&&v!==false;};
var v=k();
var h=0;
while(!r(v)&&h<n){
h++;
var e=h-1;
if(e>3)e=3;
System.delay(m*(1<<e));
v=k();
}
return v;
},




fetch:function(z,d,l,u){
var g=false;
try{g=!!Net.download(z,d,u||null);}catch(e){g=false;}
if(!g)return false;
if(l){
var f='';
try{f=FS.getFileMD5(d)||'';}catch(e2){f='';}
if(f!==l){
try{FS.deleteFile(d);}catch(e3){}
return false;
}
}
return true;
},



readText:function(q){
try{return FS.readTextFile(q);}catch(e){return null;}
}
};

A._mods.push('net');

module.exports=A;
