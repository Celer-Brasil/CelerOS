
















var A=require('celeros.app');

A.fmt={
version:'1.0.2',


bytes:function(n){
if(!n||n<=0)return'';
if(n<1024)return n+' B';
var v;
if(n<1048576){
v=Math.round(n/102.4)/10;
return(v%1?v:v.toFixed(0))+' KB';
}
v=Math.round(n/104857.6)/10;
return(v%1?v:v.toFixed(0))+' MB';
},


uptime:function(l){
if(!l||l<0)l=0;
var s=Math.floor(l/1000);
var d=Math.floor(s/86400);s-=d*86400;
var h=Math.floor(s/3600);s-=h*3600;
var m=Math.floor(s/60);
if(d>0)return d+'d '+h+'h';
if(h>0)return h+'h '+m+'m';
return m+'m';
},


pad2:function(n){return(n<10?'0':'')+n;},




clock:function(E){
var t=System.getTime();
if(!E||!/^\d\d:\d\d$/.test(t))return t;
return t+':'+A.fmt.pad2(System.getSeconds());
},



when:function(u){
if(!u)return'';
var d=new Date(u*1000);
return A.fmt.pad2(d.getDate())+'/'+A.fmt.pad2(d.getMonth()+1)+' '+
A.fmt.pad2(d.getHours())+':'+A.fmt.pad2(d.getMinutes());
},


dur:function(c){
if(!c||c<0)c=0;
if(c<6e4){
var s=Math.round(c/100)/10;
return(s%1?s:s.toFixed(0))+' s';
}
var m=Math.floor(c/6e4);

var p=Math.round((c%6e4)/1000);
if(p>=60){p=0;m++;}
return m+'m '+A.fmt.pad2(p)+'s';
},



sw:function(f){
if(!f||f<0)f=0;
var B=Math.floor(f/10)%100;
var s=Math.floor(f/1000)%60;
var m=Math.floor(f/6e4);
var w=A.fmt.pad2(s)+'.'+A.fmt.pad2(B);
if(m<60)return A.fmt.pad2(m)+':'+w;
var h=Math.floor(m/60);
return h+':'+A.fmt.pad2(m%60)+':'+w;
}
};

A._mods.push('fmt');

module.exports=A;
