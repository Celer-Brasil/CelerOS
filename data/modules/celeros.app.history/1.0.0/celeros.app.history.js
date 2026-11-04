













var A=require('celeros.app');
require('celeros.app.data');

A.history={
version:'1.0.0',


new:function(o){
o=o||{};
var e=A.data.file(o.file||'historico.json');
var g=o.max||50;
var a=A.data.load(e,[]);
if(!a||typeof a.length!=='number')a=[];
var h={
all:function(){return a;},

push:function(s){
s=String(s===null||s===undefined?'':s);
if(!s)return false;
if(a.length&&a[a.length-1]===s)return false;
a.push(s);
if(a.length>g)a.shift();
A.data.save(e,a);
return true;
},
last:function(){return a.length?a[a.length-1]:'';},
clear:function(){a=[];A.data.save(e,a);}
};
return h;
}
};

A._mods.push('history');

module.exports=A;
