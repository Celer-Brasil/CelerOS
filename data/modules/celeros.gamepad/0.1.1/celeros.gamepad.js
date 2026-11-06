


































var e={version:'0.1.1'};




var jb=128,kb=144,ib=176;
var gb=160,hb=192;
var cb=4,Ya=20,Xa=36;
var bb=116,ab=132,$a=148;
var _a=164,Za=180;
var db=8,fb=24,eb=40;


var w=1,lb=9;

var mb=57;
var ob=48,pb=49,qb=50,nb=51,za=52,Aa=53;


function vb(ea){
if(ea===0)return 0;
if(ea===1)return 1;
if(ea===2)return 2;
return 4;
}


function Db(sb,i,ca){
var v=0,Qa=0,b;
for(var k=0;k<ca;k++){
b=sb[i+k]||0;
v+=b*Math.pow(2,Qa);
Qa+=8;
}
var Ga=ca*8;
if(ca<4&&v>=Math.pow(2,Ga-1))v-=Math.pow(2,Ga);
return v;
}





e.parseMap=function(pa){
var P={};
var q=0;
var g={page:0,min:0,max:0,size:0,count:0};
var va=[];
var $=[];
var K=-1,J=-1;
var I={in:{},out:{},feat:{}};
var i=0,n=pa.length;
while(i<n){
var b=pa[i];
var da=vb(b&3);
var h=b&252;
var l=da>0?Db(pa,i+1,da):0;
i+=1+da;
if(h===cb){g.page=l;continue;}
if(h===Ya){g.min=l;continue;}
if(h===Xa){g.max=l;continue;}
if(h===bb){g.size=l;continue;}
if(h===ab){q=l;continue;}
if(h===$a){g.count=l;continue;}
if(h===_a){va.push(JSON.stringify(g));continue;}
if(h===Za){
if(va.length>0){
var s=JSON.parse(va.pop());
g.page=s.page;g.min=s.min;g.max=s.max;
g.size=s.size;g.count=s.count;
}
continue;
}
if(h===db){
$.push(l<65536?((g.page<<16)|l):l);
continue;
}
if(h===fb){
K=l<65536?((g.page<<16)|l):l;
continue;
}
if(h===eb){
J=l<65536?((g.page<<16)|l):l;
continue;
}
if(h===gb||h===hb){
$=[];K=J=-1;
continue;
}
var p=null;
if(h===jb)p='in';
else if(h===kb)p='out';
else if(h===ib)p='feat';
else continue;
var ub=(l&1)!==0;




if(g.size>0&&g.count>0){
if(I[p][q]===undefined){

I[p][q]=q?8:0;
}
if(!ub){
var na=String(q)+'|'+p;
if(P[na]===undefined)P[na]=[];
var V=$.slice();
if(V.length===0&&K>=0&&J>=0&&J>=K){
for(var u=K;u<=J;u++)V.push(u);
}
var B=V.length>0?V:null;
for(var c=0;c<g.count;c++){
var O=g.page,xa=0;
if(B!==null&&B.length===g.count){
O=(B[c]>>16)&65535;
xa=B[c]&65535;
}else if(B!==null&&B.length>0){


O=(B[0]>>16)&65535;
xa=B[0]&65535;
}
if(O===0)O=g.page;
P[na].push({
t:p,id:q,page:O,usage:xa,
off:I[p][q]||0,bits:g.size,
min:g.min,max:g.max
});
I[p][q]=(I[p][q]||0)+g.size;
}
}else{

I[p][q]+=g.size*g.count;
}
}
$=[];K=J=-1;
}
var ja=[];
for(var kk in P){
var id=kk.split('|')[0];
if(ja.indexOf(id)<0)ja.push(id);
}
return{reports:P,ids:ja};
};


function L(Eb,f){
var v=0;
for(var k=0;k<f.bits;k++){
var Fa=Eb[(f.off+k)>>3];
if(Fa===undefined)return null;
if(((Fa>>((f.off+k)&7))&1)!==0)v+=Math.pow(2,k);
}
return v;
}


e.axis=function(Cb,F){
var v=Cb;
if(v>F)v=(v-F)/(1-F);
else if(v<-F)v=(v+F)/(1-F);
else return 0;
return v<-1?-1:(v>1?1:v);
};

var Wa=['n','ne','e','se','s','sw','w','nw'];




var Va=['a','b','x','y','l1','r1','select','start','guide','ls','rs'];

function x(Ha,Bb,Gb,Ua){
for(var i=0;i<Ha.length;i++){
var f=Ha[i];
if(f.page!==Bb||f.usage!==Gb)continue;
if(Ua===true&&f.min<0)continue;
if(Ua===false&&f.min>=0)continue;
return f;
}
return null;
}



e.Gamepad=function(){
this.map=null;
this.mainId=0;
this.mainHasId=false;
this.inFields=[];

this.fLx=this.fLy=this.fRx=this.fRy=null;
this.fL2=this.fR2=this.fHat=null;
this.outId=0;
this.outLen=0;
this.profile='generic';
this.dead=.10;
this.connected=false;
this.name='';
this.state=null;
this.prevBtns={};
};


e.Gamepad.prototype.setup=function(){
var qa=BT.reportMap();
if(!qa||qa.length===0)return false;
this.map=e.parseMap(qa);
var R=null,Da=0,_,i;
for(_ in this.map.reports){
if(_.indexOf('|in')<0)continue;
var Ia=this.map.reports[_];
var ya=0;
for(i=0;i<Ia.length;i++){
if(Ia[i].usage!==0)ya++;
}
if(ya>Da){Da=ya;R=_;}
}
if(R===null)return false;
this.mainId=parseInt(R.split('|')[0],10)||0;
this.mainHasId=this.mainId!==0;
this.inFields=this.map.reports[R];




this.fLx=x(this.inFields,w,ob);
this.fLy=x(this.inFields,w,pb);
this.fRx=x(this.inFields,w,qb);
this.fRy=x(this.inFields,w,Aa);
if(this.fRy===null){
var ua=x(this.inFields,w,za);
if(ua!==null&&ua.min<0)this.fRy=ua;
}
this.fL2=x(this.inFields,w,nb,true);
if(this.fRy===null||x(this.inFields,w,Aa)!==null){
this.fR2=x(this.inFields,w,za,true);
}else{
this.fR2=null;
}
this.fHat=x(this.inFields,w,mb);


var sa=null,ra=0;
for(var kk in this.map.reports){
if(kk.indexOf('|out')<0)continue;
var fs=this.map.reports[kk];
var ba=0,j;
for(j=0;j<fs.length;j++)ba+=fs[j].bits;
if(ba>ra){ra=ba;sa=kk;}
}
if(sa!==null){
this.outId=parseInt(sa.split('|')[0],10)||0;
this.outLen=(ra+7)>>3;
}

var ka=BT.state();
if(ka&&ka.name){
var nm=ka.name.toLowerCase();
if(nm.indexOf('xbox')>=0)this.profile='xbox';
}
this.connected=true;
return true;
};


e.Gamepad.prototype.decode=function(C){
var t={
lx:0,ly:0,rx:0,ry:0,l2:0,r2:0,dpad:'',
buttons:{},pressed:[],released:[],
b:[],battery:-1
};
var y,sv,o,norm,i,f,v;
for(i=0;i<this.inFields.length;i++){
f=this.inFields[i];
if(f.page===lb&&f.usage>0){
v=L(C,f);
if(v===null)continue;
if(v){
var nm=Va[f.usage-1]||('b'+f.usage);
t.buttons[nm]=true;
t.b.push(nm);
}
}
}


function T(f,Fb){
o=L(Fb,f);
if(o===null)return 0;
sv=f.min<0?(o>=Math.pow(2,f.bits-1)?o-Math.pow(2,f.bits):o):o;
y=f.max-f.min;
if(y<=0)return 0;
return(sv-f.min)/y*2-1;
}
if(this.fLx)t.lx=e.axis(T(this.fLx,C),this.dead);
if(this.fLy)t.ly=e.axis(T(this.fLy,C),this.dead);
if(this.fRx)t.rx=e.axis(T(this.fRx,C),this.dead);
if(this.fRy)t.ry=e.axis(T(this.fRy,C),this.dead);

if(this.fL2){
o=L(C,this.fL2);
y=this.fL2 .max-this.fL2 .min;
t.l2=o===null||y<=0?0:(o-this.fL2 .min)/y;
}
if(this.fR2){
o=L(C,this.fR2);
y=this.fR2 .max-this.fR2 .min;
t.r2=o===null||y<=0?0:(o-this.fR2 .min)/y;
}
if(this.fHat){
v=L(C,this.fHat);
if(v!==null&&v>=0&&v<8)t.dpad=Wa[v];
}
return t;
};


e.Gamepad.prototype.poll=function(){
if(!this.connected)return null;
var z=null;
var r;
while((r=BT.read())!==null){
if(this.mainHasId&&r.id!==this.mainId)continue;
z=this.decode(r.data);
}
if(z===null)return null;
var Oa=this.prevBtns;
var H;
for(H in z.buttons){
if(!Oa[H])z.pressed.push(H);
}
for(H in Oa){
if(!z.buttons[H])z.released.push(H);
}
this.prevBtns=z.buttons;
this.state=z;
return z;
};


e.Gamepad.prototype.state=function(){return this.state;};



e.Gamepad.prototype.rumble=function(Ra,Ea,ms){
if(!this.connected||this.outLen===0)return false;
var m=[];
if(this.outId)m.push(this.outId&255);
if(this.profile==='xbox'){
m.push(0);
m.push(Math.round((Ra||0)*255)&255);
m.push(Math.round((Ea||0)*255)&255);
m.push(255);
m.push(0);
m.push(Math.round((ms||0)/2.5)&255);
}else if(m.length===0){
m.push(Math.round((Ra||0)*255)&255);
m.push(Math.round((Ea||0)*255)&255);
}
while(m.length<this.outLen)m.push(0);
var r=BT.write(m);
return!!(r&&r.ok);
};





e.pads=function(){
var Na=[];
var La=typeof BT!=='undefined'?BT.scanResults():[];
for(var i=0;i<La.length;i++){
var d=La[i];
Na.push({
addr:d.addr,name:d.name,rssi:d.rssi,
gamepad:d.appearance===964,
hid:true
});
}
return Na;
};

e.scan=function(ms){
if(typeof BT==='undefined')return[];
BT.scan(ms||3000);
return e.pads();
};

e.connect=function(rb){
if(typeof BT==='undefined')return{ok:false,err:'sem BT'};
return BT.connect(rb);
};

e.disconnect=function(){
if(typeof BT==='undefined')return;
BT.disconnect();
};


e.setup=function(){
if(typeof BT==='undefined')return null;
var la=BT.state();
if(!la||la.phase!=='ready')return null;
var g=new e.Gamepad();
g.name=la.name||'';
if(!g.setup())return null;
return g;
};

module.exports=e;
