

















var c={version:'1.0.1'};


c.available=function(){
return typeof USB!=="undefined"&&System.getInfo().hasUsbHost===true;
};




c.devices=function(){
if(!c.available())return[];
return USB.devices();
};



c.find=function(g){
g=g||{};
var Q=c.devices();
for(var i=0;i<Q.length;i++){
var d=Q[i];
if(g.vid!==undefined&&d.vid!==g.vid)continue;
if(g.pid!==undefined&&d.pid!==g.pid)continue;
if(g.cls!==undefined&&d.cls!==g.cls)continue;
if(g.subcls!==undefined&&d.subcls!==g.subcls)continue;
if(g.proto!==undefined&&d.proto!==g.proto)continue;
return d;
}
return null;
};


c.ifaceOf=function(p,M,W,U){
if(!p||!p.ifs)return null;
for(var i=0;i<p.ifs.length;i++){
var f=p.ifs[i];
if(M!==undefined&&f.cls!==M)continue;
if(W!==undefined&&f.subcls!==W)continue;
if(U!==undefined&&f.proto!==U)continue;
return f;
}
return null;
};



c.ep=function(v,fa,_){
if(!v||!v.eps)return-1;
var ga=(_==="in");
for(var i=0;i<v.eps.length;i++){
var e=v.eps[i];
if(e.type!==fa)continue;
if(((e.addr&128)!==0)!==ga)continue;
return e.addr;
}
return-1;
};




c.open=function(n,J){
J=J||{};
if(!n)return null;
var m=n.ifs||[];
var j=J.iface||null;
if(!j){
for(var i=0;i<m.length;i++){
if(c.ep(m[i],2,"out")>=0||c.ep(m[i],2,"in")>=0){
j=m[i];
break;
}
}
}
if(!j&&m.length)j=m[0];
if(!j)return null;
if(!USB.claim(n.addr,j.n,j.alt))return null;
return{
addr:n.addr,
dev:n,
iface:j,
epOut:c.ep(j,2,"out"),
epIn:c.ep(j,2,"in"),
epIntIn:c.ep(j,3,"in")
};
};


c.close=function(h){
if(!h)return false;
return USB.release(h.addr,h.iface.n);
};


c.write=function(h,Y,da){
if(!h||h.epOut<0)return{ok:false,status:"error",sent:0};
return USB.out(h.addr,h.epOut,Y,da);
};

c.read=function(h,$,ea){
if(!h||h.epIn<0)return{ok:false,status:"error",len:0,data:[]};
return USB.in(h.addr,h.epIn,$,ea);
};


c.printFile=function(h,ca,ba){
if(!h||h.epOut<0)return{ok:false,status:"error",sent:0};
return USB.sendFile(h.addr,h.epOut,ca,ba);
};


c.listen=function(h,N,aa,Z){
if(!h)return false;
return USB.listen(h.addr,N===undefined?h.epIntIn:N,aa,Z);
};

c.readReport=function(h,O){
if(!h)return null;
return USB.read(h.addr,O===undefined?h.epIntIn:O);
};

c.stopListen=function(h,P){
if(!h)return false;
return USB.unlisten(h.addr,P===undefined?h.epIntIn:P);
};


c.poll=function(){
if(!c.available())return null;
return USB.poll();
};




c.bytes=function(s){
var R=[];
s=String(s);
for(var i=0;i<s.length;i++)R.push(s.charCodeAt(i)&255);
return R;
};

c.ascii=c.bytes;


c.hex=function(s){
var S=[];
s=String(s).replace(/[^0-9A-Fa-f]/g,"");
if(s.length&1)s="0"+s;
for(var i=0;i<s.length;i+=2)S.push(parseInt(s.substr(i,2),16));
return S;
};



c.str=function(b){
var s="";
for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]&255);
return s;
};

c.concat=function(a,b){
var T=a.slice();
for(var i=0;i<b.length;i++)T.push(b[i]);
return T;
};

module.exports=c;
