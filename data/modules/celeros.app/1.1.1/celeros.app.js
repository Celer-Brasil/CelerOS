








































var A={version:'1.1.1'};


A.BACK='..';
A.EXIT='\u0001';

A._mods=[];
A._stack=[];
A._marks={};
A._cs={};
A._ctx={full:false,now:0,entered:false};


var P=8;




A.T=null;
A.L=null;
A.full=false;
A.init=function(){
A.T=System.theme();

var u=0;
try{u=(System.getInfo()||{}).inset||0;}catch(e){u=0;}
var m=Math.round(u/2);


A.L={x:8+m,y:48,w:224-2*m,top:48,
bottom:312-m,cx:120};
return A;
};










A.custom=function(J,x,y,w,h,D,s,o){
if(typeof s!=='function')return false;
if(UI.extras&&typeof UI.custom==='function'){
return UI.custom(J,x,y,w,h,D,s,o);
}
var L='c'+J;
if(!A.full&&A._cs[L]===D)return false;
A._cs[L]=D;
o=o||{};
if(!A.full&&o.clear!==false){
System.fillRect(x,y,w,h,
o.bg===undefined?(A.T||System.theme()).card:o.bg);
}
s(x,y,w,h);
return true;
};

A.run=function(C,I,q){
if(!A.T)A.init();
q=q||{};
A._stack.length=0;
var b=I;
var B=null;
for(;;){
var l=C[b];
if(!l){
b=I;
l=C[b];
if(!l)return;
}
var c=A._ctx;
if(b!==B){
B=b;
UI.invalidate();
c.entered=true;
}else{
c.entered=false;
}
c.now=System.millis();
c.full=UI.begin(A.T.bg);
A.full=c.full;
var r=l(c);
UI.end(typeof q.fps==='number'?q.fps:(l.fps||20));
if(r===A.EXIT){System.exitApp();return;}
if(r===A.BACK){
if(!A._stack.length){System.exitApp();return;}
b=A._stack.pop();
B=null;
continue;
}
if(typeof r==='string'&&r!==b&&C[r]){
if(A._stack.length>=P)A._stack.shift();
A._stack.push(b);
b=r;
}

}
};




A.header=function(Z,o){
if(!o)o={};
return UI.header(Z,{sub:o.sub,back:o.back!==false});
};




A.busy=function(V){
UI.invalidate();
UI.begin();
UI.header(V||'Aguarde...',{back:false});
UI.spinner(120,170,18);
UI.end(10);
};


A.progress=function(p,W){
UI.invalidate();
UI.begin();
UI.header(W||'Baixando...',{back:false});
if(p>=0){
UI.progress(40,150,160,12,p);
UI.text((p|0)+'%',120,174,{align:'center',role:'caption',color:A.T.textDim});
}else{
UI.spinner(120,160,18);
}
UI.end(10);
};



A._result=function(_,f,H){
if(typeof f==='string')f=[f];
var j=System;
for(;;){
UI.invalidate();
UI.begin(A.T.bg);
UI.header('',{back:false});
UI.card(20,90,200,160);
j.fillCircle(120,130,18,H);
if(H===A.T.err){
j.drawWideLine(112,122,128,138,3,65535);
j.drawWideLine(128,122,112,138,3,65535);
}else{
j.drawWideLine(110,130,117,140,3,65535);
j.drawWideLine(117,140,133,119,3,65535);
}
UI.text(_,120,160,{align:'center',w:176,lines:2});
if(f&&f.length){
UI.text(f.join(' '),120,190,{align:'center',w:176,lines:4,
role:'caption',color:A.T.textDim});
}
UI.cardEnd();
if(UI.button('OK',70,264,100,34))return;
UI.end(15);
}
};
A.error=function($,R){A._result($,R,A.T.err);};
A.ok=function(aa,S){A._result(aa,S,A.T.ok);};




A.wifiWait=function(X){
for(;;){
var O=false;
try{O=Net.isConnected();}catch(e){return false;}
if(O)return true;
UI.invalidate();
UI.begin(A.T.bg);
UI.header('Wi-Fi',{back:false});
UI.card(20,90,200,120);
UI.spinner(120,128,14);
UI.text(X||'Esperando a rede voltar...',120,154,{align:'center',w:176,
lines:3,role:'caption',color:A.T.textDim});
UI.cardEnd();
if(UI.button('Cancelar',70,264,100,34))return false;
UI.end(8);
}
};





A.now=function(){return System.millis();};
A.every=function(T,Q){
var N=System.millis();
var k=Q||'_';
var M=A._marks[k];
if(M===undefined||N-M>=T){A._marks[k]=N;return true;}
return false;
};


A.toast=function(Y,U){UI.toast(Y,U);};
A.exit=function(){System.exitApp();};

module.exports=A;
