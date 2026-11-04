



















var A=require('celeros.app');

A.data={
version:'1.0.0',



load:function(l,j){
try{
var s=FS.readTextFile(l);
if(s){
var v=JSON.parse(s);
if(v!==undefined&&v!==null)return v;
}
}catch(e){}
return j;
},

save:function(m,v){
try{return FS.writeTextFile(m,JSON.stringify(v));}catch(e){return false;}
},



loadState:function(n,k){
try{
var s=Storage.get(n);
if(s)return JSON.parse(s);
}catch(e){}
return k;
},

saveState:function(o,v){
try{return Storage.set(o,JSON.stringify(v));}catch(e){return false;}
},


stale:function(c,p){
if(!c||!c.at)return true;
return(System.millis()-c.at)>=p;
},




file:function(g){
var d='';
try{d=FS.appData()||'';}catch(e){d='';}
return d?d+g:String(g);
}
};

A._mods.push('data');

module.exports=A;
