

var A=require('celeros.app');
require('celeros.app.caps');

function b(F){
return isFinite(F)?Math.max(0,Math.floor(F)):0;
}



function k(P,t,v,i){
return Math.floor((P-(t-1)*v)*i/t)+v*i;
}


function u(Q,l,L){
if(l===1)return 0;
return Math.min(L,Math.max(0,Math.floor((Q-l)/(l-1))));
}

A.layout={
version:'1.0.0',

bounds:function(o){
o=o||{};
var j=A.caps.probe();
var w=System.screenWidth(),h=System.screenHeight();
var q=o.pad===undefined?4:b(o.pad);
var O=Math.ceil(j.inset*w/240);
var B=Math.ceil(j.inset*j.w/240*h/j.h);
var x=Math.min(Math.floor(w/2),Math.max(q,O));
var y=Math.min(h,Math.max(B,b(o.top)+q));
var K=Math.max(B,b(o.bottom)+q);
return{x:x,y:y,w:w-2*x,h:Math.max(0,h-y-K)};
},


columns:function(T,S,M){
var U=A.caps.probe().w/System.screenWidth();
var D=b(M);
var R=Math.max(1,Math.ceil(b(S)/U));
return Math.max(1,Math.floor((T.w+D)/(R+D)));
},

cell:function(c,a,d,g,N){
if(a!==b(a)||d!==b(d)||!a||!d||
g!==b(g)||g>=a*d){
throw new RangeError('layout.cell: grade ou indice invalido');
}
var s=g%a,C=Math.floor(g/a);
var E=b(N);
var m=u(c.w,a,E);
var n=u(c.h,d,E);
var x=k(c.w,a,m,s),y=k(c.h,d,n,C);
return{x:c.x+x,y:c.y+y,
w:k(c.w,a,m,s+1)-m-x,
h:k(c.h,d,n,C+1)-n-y};
}
};

A._mods.push('layout');
module.exports=A;
