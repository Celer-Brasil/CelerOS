




















var A=require('celeros.app');
require('celeros.app.data');
require('celeros.app.text');
require('celeros.app.net');

A.ai={
version:'1.0.0',



client:function(o){
o=o||{};
var q=(typeof AI!=='undefined')&&(typeof AI.chat==='function');
var B=o.ctx||12;
var C=o.max||20;
var v=A.data.file(o.file||'historico.json');
var l=o.note||function(){};
var h=o.err||function(){};
var E=o.onmsg||function(){};
var b=A.data.load(v,[]);
if(!b||typeof b.length!=='number')b=[];

function x(){A.data.save(v,b);}
function y(z,G){
var m={r:z,s:A.text.fit(G)};
b.push(m);
if(b.length>C)b.shift();
E(z,m.s);
x();
return m;
}

var c={
busy:false,
hist:b,
ok:q,


send:function(H){
if(c.busy){l('(a IA ainda está respondendo)');return false;}
if(!q){h('sem AI no firmware (requer API >= 18)');return false;}
var p=false;
try{p=AI.configured();}catch(e){p=false;}
if(!p){h('IA sem chave: configure o provedor');return false;}
if(!A.net.online()){h('sem WiFi');return false;}
y('user',H);
var t=[];
if(o.system)t.push({role:'system',content:o.system});
var F=Math.max(0,b.length-B);
for(var i=F;i<b.length;i++){
t.push({role:b[i].r,content:b[i].s});
}
return c._ask(t,false);
},



_ask:function(w,D){
if(c.busy)return false;
c.busy=true;
var u=false;
try{
u=AI.chat({messages:w,max_tokens:o.maxTokens||400},
function(r){
c.busy=false;
if(!D&&r&&!r.ok&&
(r.status===502||r.status===504||r.status===429)){
l('repetindo...');
setTimeout(function(){c._ask(w,true);},2000);
return;
}
if(r&&r.ok&&r.content){
y('assistant',r.content);
if(r.usage&&r.usage.total_tokens){
l('('+r.usage.total_tokens+' tokens)');
}
}else if(r&&r.ok){
h('IA: resposta vazia');
}else{
h('IA: erro '+(r&&r.error?r.error:'HTTP '+(r?r.status:0)));
if(r&&r.detail)l('detalhe: '+A.text.fit(r.detail));
}
UI.invalidate();
});
}catch(e){


c.busy=false;
h('IA: '+(e&&e.message?e.message:e));
UI.invalidate();
return false;
}
if(!u){
c.busy=false;
h('IA: ocupado, tente de novo');
}
UI.invalidate();
return u;
},

cancel:function(){
var n=false;
try{n=q&&c.busy&&AI.cancel();}catch(e){n=false;}
if(n)c.busy=false;
return n;
},

clear:function(){
b.length=0;
x();
UI.invalidate();
}
};
return c;
}
};

A._mods.push('ai');

module.exports=A;
