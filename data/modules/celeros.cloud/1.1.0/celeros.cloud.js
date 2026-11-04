





























var f={version:'1.1.0'};

var H='/local/celercloud.json';
var t='/local/cloud_outbox.json';
var z='/local/cloud_desired.json';
var G='/local/cloud_commands.json';
var V=50;
var I=50;

var a=null;
var u=0;
var k=null;
var c=[];
var m=[];
var A=0;
var g='';

function o(Q,C){
try{
if(typeof FS==='undefined'||!FS.exists(Q))return C;
var U=FS.readTextFile(Q);
if(!U)return C;
return JSON.parse(U);
}catch(e){
return C;
}
}

function y(aa,ba){
try{
FS.writeTextFile(aa,JSON.stringify(ba));
return true;
}catch(e){
return false;
}
}

function N(){
try{return System.millis();}catch(e){return Date.now?Date.now():0;}
}

function l(ca){
return Object.prototype.toString.call(ca)==='[object Array]';
}

function Z(){
return typeof Net!=='undefined'&&typeof Net.request==='function';
}

function $(){
try{
return(typeof System!=='undefined'&&typeof System.getOSVersion==='function')
?String(System.getOSVersion()||''):'';
}catch(e){return'';}
}

function _(){
try{
return(typeof System!=='undefined'&&typeof System.getAPILevel==='function')
?(Number(System.getAPILevel())||0):0;
}catch(e){return 0;}
}

function S(){
if(c.length>I){
c=c.slice(c.length-I);
}
return y(G,c);
}

f.init=function(R){
a=null;
k=null;
c=o(G,[]);
if(!l(c))c=[];
m=[];
u=0;
g='';
var d=o(R||H,null);
if(!d||!d.url||!d.key||!d.tenantId||!d.deviceId||!d.secret){
g='config ausente/incompleta em '+(R||H);
return false;
}
var W=String(d.url).replace(/\/+$/,'');
d.endpoint=d.endpoint||(W+'/functions/v1/device-heartbeat');
d.heartbeatMs=typeof d.heartbeatMs==='number'?d.heartbeatMs:6e4;
d.timeoutMs=typeof d.timeoutMs==='number'?d.timeoutMs:8000;
a=d;
k=o(z,null);
return true;
};

f.configured=function(){
return!!a;
};

f.lastError=function(){
return g;
};


f.desired=function(){
if(k===null)k=o(z,null);
return k;
};



f.commands=function(){
return c.slice(0);
};


f.ack=function(E){
var L=l(E)?E:[E];
for(var i=0;i<L.length&&m.length<20;i++){
var K=L[i];
if(!K)continue;
var s=String(K);
m.push(s);
for(var j=0;j<c.length;j++){
if(c[j]&&c[j].id===s){
c.splice(j,1);
j--;
}
}
}
S();
return m.length;
};


f.report=function(n){
if(!n||!n.type)return false;
var r=o(t,[]);
if(!l(r))r=[];
if(r.length>=V)r.shift();
A++;
r.push({
id:n.id?String(n.id):('ev-'+(a?a.deviceId:'dev')+'-'+N()+'-'+A),
type:String(n.type),
severity:n.severity||'info',
payload:n.payload||{}
});
return y(t,r);
};

f.pending=function(){
var P=o(t,[]);
return l(P)?P.length:0;
};





f.heartbeat=function(b,Y){
if(!a)return null;
if(!Z()){
g='Net.request indisponivel (API < 49)';
return null;
}
var O=N();
if(!Y&&u&&(O-u)<a.heartbeatMs){
return f.desired();
}
b=b||{};
var F=o(t,[]);
if(!l(F))F=[];

var v={
tenant_id:a.tenantId,
device_id:a.deviceId,
secret:a.secret,
kind:b.kind||a.kind||'generic',
label:b.label||a.label||'',
board:b.board||a.board||'',
firmware:b.firmware||a.firmware||$(),
api_level:typeof b.apiLevel==='number'
?b.apiLevel
:(typeof a.apiLevel==='number'?a.apiLevel:_()),
uptime_s:typeof b.uptimeS==='number'?b.uptimeS:0,
events:F,
ack:m
};
if(typeof b.rssi==='number')v.rssi=b.rssi;
if(l(b.apps))v.apps=b.apps;
if(b.caps&&typeof b.caps==='object')v.caps=b.caps;
if(l(b.resources))v.resources=b.resources.slice(0,32);

var p=null;
try{
p=Net.request({
url:a.endpoint,
method:'POST',
body:JSON.stringify(v),
contentType:'application/json',
headers:{
apikey:a.key,
Authorization:'Bearer '+a.key
},
timeoutMs:a.timeoutMs
});
}catch(e){
p=null;
g='Net.request: '+e;
}

if(!p){
if(!g)g='sem rede';
return null;
}
if(p.status<200||p.status>=300){
g='HTTP '+p.status;
return null;
}

var h=null;
try{h=JSON.parse(p.body);}catch(e2){h=null;}
if(!h||h.ok!==true){
g='resposta invalida';
return null;
}

u=O;
g='';
if(h.desired){
k=h.desired;
y(z,k);
}
if(l(h.commands)&&h.commands.length){
var J=false;
for(var B=0;B<h.commands.length;B++){
var x=h.commands[B];
if(!x||!x.id)continue;
var M=false;
for(var w=0;w<c.length;w++){
if(c[w]&&c[w].id===x.id){M=true;break;}
}
if(!M){
c.push(x);
J=true;
}
}
if(J)S();
}

y(t,[]);
m=[];
return k;
};

f.reset=function(){
a=null;
k=null;
c=[];
m=[];
u=0;
A=0;
g='';
};

module.exports=f;
