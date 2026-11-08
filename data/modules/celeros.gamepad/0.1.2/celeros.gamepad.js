






































var e={version:'0.1.2'};




var lb=128,mb=144,kb=176;
var ib=160,jb=192;
var eb=4,_a=20,Za=36;
var db=116,cb=132,bb=148;
var ab=164,$a=180;
var fb=8,hb=24,gb=40;


var w=1,nb=9;

var ob=57;
var qb=48,rb=49,sb=50,pb=51,ya=52,za=53;


function yb(ca){
if(ca===0)return 0;
if(ca===1)return 1;
if(ca===2)return 2;
return 4;
}





function Gb(ub,i,vb){
var v=0,Qa=0,b;
for(var k=0;k<vb;k++){
b=ub[i+k]||0;
v+=b*Math.pow(2,Qa);
Qa+=8;
}
return v;
}



function Ra(v,Ga){
var Fa=Ga*8;
if(Ga<4&&v>=Math.pow(2,Fa-1))v-=Math.pow(2,Fa);
return v;
}





e.parseMap=function(na){
var Q={};
var q=0;
var g={page:0,min:0,max:0,size:0,count:0};
var ta=[];
var aa=[];
var K=-1,J=-1;
var I={in:{},out:{},feat:{}};
var i=0,n=na.length;
while(i<n){
var b=na[i];
var L=yb(b&3);
var h=b&252;
var l=L>0?Gb(na,i+1,L):0;
i+=1+L;
if(h===eb){g.page=l;continue;}
if(h===_a){g.min=Ra(l,L);continue;}
if(h===Za){g.max=Ra(l,L);continue;}
if(h===db){g.size=l;continue;}
if(h===cb){q=l;continue;}
if(h===bb){g.count=l;continue;}
if(h===ab){ta.push(JSON.stringify(g));continue;}
if(h===$a){
if(ta.length>0){
var s=JSON.parse(ta.pop());
g.page=s.page;g.min=s.min;g.max=s.max;
g.size=s.size;g.count=s.count;
}
continue;
}
if(h===fb){
aa.push(l<65536?((g.page<<16)|l):l);
continue;
}
if(h===hb){
K=l<65536?((g.page<<16)|l):l;
continue;
}
if(h===gb){
J=l<65536?((g.page<<16)|l):l;
continue;
}
if(h===ib||h===jb){
aa=[];K=J=-1;
continue;
}
var p=null;
if(h===lb)p='in';
else if(h===mb)p='out';
else if(h===kb)p='feat';
else continue;
var xb=(l&1)!==0;




if(g.size>0&&g.count>0){
if(I[p][q]===undefined){

I[p][q]=q?8:0;
}
if(!xb){
var la=String(q)+'|'+p;
if(Q[la]===undefined)Q[la]=[];
var W=aa.slice();
if(W.length===0&&K>=0&&J>=0&&J>=K){
for(var u=K;u<=J;u++)W.push(u);
}
var B=W.length>0?W:null;
for(var c=0;c<g.count;c++){
var P=g.page,va=0;
if(B!==null&&B.length===g.count){
P=(B[c]>>16)&65535;
va=B[c]&65535;
}else if(B!==null&&B.length>0){


P=(B[0]>>16)&65535;
va=B[0]&65535;
}
if(P===0)P=g.page;
Q[la].push({
t:p,id:q,page:P,usage:va,
off:I[p][q]||0,bits:g.size,
min:g.min,max:g.max
});
I[p][q]=(I[p][q]||0)+g.size;
}
}else{

I[p][q]+=g.size*g.count;
}
}
aa=[];K=J=-1;
}
var ha=[];
for(var kk in Q){
var id=kk.split('|')[0];
if(ha.indexOf(id)<0)ha.push(id);
}
return{reports:Q,ids:ha};
};


function M(Hb,f){
var v=0;
for(var k=0;k<f.bits;k++){
var Ea=Hb[(f.off+k)>>3];
if(Ea===undefined)return null;
if(((Ea>>((f.off+k)&7))&1)!==0)v+=Math.pow(2,k);
}
return v;
}


e.axis=function(Fb,F){
var v=Fb;
if(v>F)v=(v-F)/(1-F);
else if(v<-F)v=(v+F)/(1-F);
else return 0;
return v<-1?-1:(v>1?1:v);
};

var Ya=['n','ne','e','se','s','sw','w','nw'];




var Xa=['a','b','x','y','l1','r1','select','start','guide','ls','rs'];

function x(Ha,Eb,Jb,Wa){
for(var i=0;i<Ha.length;i++){
var f=Ha[i];
if(f.page!==Eb||f.usage!==Jb)continue;
if(Wa===true&&f.min<0)continue;
if(Wa===false&&f.min>=0)continue;
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
var oa=BT.reportMap();
if(!oa||oa.length===0)return false;
this.map=e.parseMap(oa);
var S=null,Ca=0,$,i;
for($ in this.map.reports){
if($.indexOf('|in')<0)continue;
var Ia=this.map.reports[$];
var wa=0;
for(i=0;i<Ia.length;i++){
if(Ia[i].usage!==0)wa++;
}
if(wa>Ca){Ca=wa;S=$;}
}
if(S===null)return false;
this.mainId=parseInt(S.split('|')[0],10)||0;
this.mainHasId=this.mainId!==0;
this.inFields=this.map.reports[S];




this.fLx=x(this.inFields,w,qb);
this.fLy=x(this.inFields,w,rb);
this.fRx=x(this.inFields,w,sb);
this.fRy=x(this.inFields,w,za);
if(this.fRy===null){
var sa=x(this.inFields,w,ya);
if(sa!==null&&sa.min<0)this.fRy=sa;
}
this.fL2=x(this.inFields,w,pb,true);
if(this.fRy===null||x(this.inFields,w,za)!==null){
this.fR2=x(this.inFields,w,ya,true);
}else{
this.fR2=null;
}
this.fHat=x(this.inFields,w,ob);


var qa=null,pa=0;
for(var kk in this.map.reports){
if(kk.indexOf('|out')<0)continue;
var fs=this.map.reports[kk];
var ba=0,j;
for(j=0;j<fs.length;j++)ba+=fs[j].bits;
if(ba>pa){pa=ba;qa=kk;}
}
if(qa!==null){
this.outId=parseInt(qa.split('|')[0],10)||0;
this.outLen=(pa+7)>>3;
}

var ia=BT.state();
if(ia&&ia.name){
var nm=ia.name.toLowerCase();
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
if(f.page===nb&&f.usage>0){
v=M(C,f);
if(v===null)continue;
if(v){
var nm=Xa[f.usage-1]||('b'+f.usage);
t.buttons[nm]=true;
t.b.push(nm);
}
}
}


function U(f,Ib){
o=M(Ib,f);
if(o===null)return 0;
sv=f.min<0?(o>=Math.pow(2,f.bits-1)?o-Math.pow(2,f.bits):o):o;
y=f.max-f.min;
if(y<=0)return 0;
return(sv-f.min)/y*2-1;
}
if(this.fLx)t.lx=e.axis(U(this.fLx,C),this.dead);
if(this.fLy)t.ly=e.axis(U(this.fLy,C),this.dead);
if(this.fRx)t.rx=e.axis(U(this.fRx,C),this.dead);
if(this.fRy)t.ry=e.axis(U(this.fRy,C),this.dead);

if(this.fL2){
o=M(C,this.fL2);
y=this.fL2 .max-this.fL2 .min;
t.l2=o===null||y<=0?0:(o-this.fL2 .min)/y;
}
if(this.fR2){
o=M(C,this.fR2);
y=this.fR2 .max-this.fR2 .min;
t.r2=o===null||y<=0?0:(o-this.fR2 .min)/y;
}
if(this.fHat){
v=M(C,this.fHat);
if(v!==null&&v>=0&&v<8)t.dpad=Ya[v];
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



e.Gamepad.prototype.rumble=function(Sa,Da,ms){
if(!this.connected||this.outLen===0)return false;
var m=[];
if(this.outId)m.push(this.outId&255);
if(this.profile==='xbox'){
m.push(0);
m.push(Math.round((Sa||0)*255)&255);
m.push(Math.round((Da||0)*255)&255);
m.push(255);
m.push(0);
m.push(Math.round((ms||0)/2.5)&255);
}else if(m.length===0){
m.push(Math.round((Sa||0)*255)&255);
m.push(Math.round((Da||0)*255)&255);
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

e.connect=function(tb){
if(typeof BT==='undefined')return{ok:false,err:'sem BT'};
return BT.connect(tb);
};

e.disconnect=function(){
if(typeof BT==='undefined')return;
BT.disconnect();
};


e.setup=function(){
if(typeof BT==='undefined')return null;
var ja=BT.state();
if(!ja||ja.phase!=='ready')return null;
var g=new e.Gamepad();
g.name=ja.name||'';
if(!g.setup())return null;
return g;
};

module.exports=e;
