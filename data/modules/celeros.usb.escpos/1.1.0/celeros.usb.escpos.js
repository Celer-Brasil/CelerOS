
















var e=require("celeros.usb");

var c={version:'1.1.0'};

var j=27;
var g=29;
var FS=28;

c.ESC=j;
c.GS=g;


c.initCmd=function(){return[j,64];};
c.feedCmd=function(n){return[j,100,(n||1)&255];};
c.alignCmd=function(a){return[j,97,a&3];};
c.boldCmd=function(on){return[j,69,on?1:0];};
c.underlineCmd=function(n){return[j,45,(n||0)&3];};
c.reverseCmd=function(on){return[g,66,on?1:0];};


c.sizeCmd=function(w,h){
w=w||1;h=h||1;
if(w<1)w=1;if(w>8)w=8;
if(h<1)h=1;if(h>8)h=8;
return[g,33,(((w-1)&7)<<4)|((h-1)&7)];
};
c.cutCmd=function(na){return[g,86,na?1:0];};
c.codepageCmd=function(n){return[j,116,n&255];};
c.drawerCmd=function(ra,ka,ea){
return[j,112,(ra||0)&1,(ka||25)&255,((ea||250)/2)&255];
};


c.barcodeCmd=function(Q){
var b=e.bytes(String(Q).toUpperCase());
var C=[g,107,4];
for(var i=0;i<b.length;i++)C.push(b[i]);
C.push(0);
return C;
};


c.qrCmd=function(R,va,G){
var d=e.bytes(R);
var H=d.length+3;
var pL=H&255;
var pH=(H>>8)&255;
var f=[];
f=e.concat(f,[g,40,107,4,0,49,65,50,0]);
var s=va||6;
if(s<1)s=1;if(s>16)s=16;
f=e.concat(f,[g,40,107,3,0,49,67,s]);
f=e.concat(f,[g,40,107,3,0,49,69,G===undefined?49:(48+(G&3))]);
f=e.concat(f,[g,40,107,pL,pH,49,80,48]);
for(var i=0;i<d.length;i++)f.push(d[i]);
f=e.concat(f,[g,40,107,3,0,49,81,48]);
return f;
};




c.open=function(y){
if(!y)return null;
var X=e.ifaceOf(y,7);
var h=e.open(y,{iface:X||undefined});
if(!h||h.epOut<0){
if(h)e.close(h);
return null;
}
return new c.Printer(h);
};

c.openByVid=function(za,qa){
return c.open(e.find({vid:za,pid:qa}));
};

c.Printer=function(h){
this.h=h;
};


c.Printer.prototype.raw=function(P){
return e.write(this.h,P,2000);
};

c.Printer.prototype.init=function(){this.raw(c.initCmd());return this;};
c.Printer.prototype.text=function(s){this.raw(e.bytes(s));return this;};
c.Printer.prototype.line=function(s){
this.raw(e.concat(e.bytes(s===undefined?"":s),[10]));
return this;
};
c.Printer.prototype.feed=function(n){this.raw(c.feedCmd(n));return this;};
c.Printer.prototype.align=function(a){this.raw(c.alignCmd(a));return this;};
c.Printer.prototype.bold=function(on){this.raw(c.boldCmd(on));return this;};
c.Printer.prototype.underline=function(n){this.raw(c.underlineCmd(n));return this;};
c.Printer.prototype.reverse=function(on){this.raw(c.reverseCmd(on));return this;};
c.Printer.prototype.size=function(w,h){this.raw(c.sizeCmd(w,h));return this;};
c.Printer.prototype.codepage=function(n){this.raw(c.codepageCmd(n));return this;};
c.Printer.prototype.barcode=function(S){this.raw(c.barcodeCmd(S));return this;};
c.Printer.prototype.qr=function(T,wa,U){this.raw(c.qrCmd(T,wa,U));return this;};
c.Printer.prototype.cut=function(oa){this.raw(c.cutCmd(oa));return this;};
c.Printer.prototype.drawer=function(sa){this.raw(c.drawerCmd(sa));return this;};












c.Printer.prototype.status=function(ya){
if(this.h.epIn<0)return null;
var n=ya||3;
var E=function(L,q){
for(var t=0;t<n;t++){
if(!e.write(L.h,[16,4,q],1000).ok)return-1;
var r=e.read(L.h,1,1000);
if(r.ok&&r.len>0)return r.data[0];
}
return-1;
};
var p=E(this,1);
if(p<0)return null;
var u={
online:(p&8)===0,
erro:(p&64)!==0,
esperando:(p&32)!==0,
papel:false,
acabando:false,
raw1:p,
raw2:-1
};
var v=E(this,2);
if(v>=0){
u.raw2=v;
u.papel=(v&96)!==0;
u.acabando=!u.papel&&(v&12)!==0;
}
return u;
};


c.Printer.prototype.file=function(pa,Y){
return e.printFile(this.h,pa,Y);
};


c.Printer.prototype.receipt=function(xa,I,J){
this.init();
this.align(1).size(2,2).bold(true).line(xa||"CELER OS");
this.size(1,1).bold(false).line("");
this.align(0);
for(var i=0;i<(I||[]).length;i++)this.line(I[i]);
this.feed(1);
if(J)this.align(1).qr(J,5,1);
this.align(0).feed(4).cut();
return this;
};

c.Printer.prototype.close=function(){
var ok=e.close(this.h);
this.h=null;
return ok;
};

module.exports=c;
