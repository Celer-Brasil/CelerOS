

















var A=require('celeros.app');
require('celeros.app.path');






function R(n){
var s=String(n===undefined||n===null?'':n);
return s.length>0&&s!=='.'&&s!=='..'&&s.indexOf('/')<0&&
s.indexOf('\\')<0&&s.indexOf('..')<0;
}

A.fsx={
version:'1.0.3',




free:function(K){
try{return FS.getFreeSpace(K||'/local')||0;}catch(e){return 0;}
},
hasRoom:function(I,L){return A.fsx.free(L)>I;},


ensureDir:function(p){
var y=String(p).split('/');
var f='';
for(var i=0;i<y.length;i++){
if(!y[i]){f='/';continue;}
f=(f==='/'?'':f)+'/'+y[i];
try{
if(!FS.isDirectory(f)&&!FS.mkdir(f))return false;
}catch(e){return false;}
}
return true;
},


treeSize:function(J){
var B=0;
var l=[];
try{l=FS.listDir(J)||[];}catch(e){return 0;}
for(var i=0;i<l.length;i++){
try{
if(FS.isDirectory(l[i]))B+=A.fsx.treeSize(l[i]);
else B+=FS.getFileSize(l[i])||0;
}catch(e2){}
}
return B;
},

copy:function(T,M){
try{return!!FS.copyDirectory(T,M);}catch(e){return false;}
},


md5:function(N){
try{return FS.getFileMD5(N)||'';}catch(e){return'';}
},









stage:function(h,C,D,G){
if(!A.fsx.ensureDir(h))return false;
var d=[];
var c='';
for(var i=0;i<C.length&&!c;i++){
var b=C[i];
if(!b||!R(b.name)){c='Nome de arquivo invalido no pacote';break;}
var j=h+'/'+b.name+'.new';
var w=false;
try{
w=!!Net.download(b.url,j,function(O,U){
if(G)G(b.name,O,U);
});
}catch(e){w=false;}
if(!w){


try{FS.deleteFile(j);}catch(e9){}
c='Erro ao baixar '+b.name;
break;
}
if(b.md5&&A.fsx.md5(j)!==b.md5){
try{FS.deleteFile(j);}catch(e2){}
c='Verificacao falhou (md5)';
break;
}
d.push({tmp:j,dst:h+'/'+b.name});
}

if(!c&&D){
var E=h+'/app.json.new';
if(!FS.writeTextFile(E,D))c='Erro ao gravar app.json';
else d.push({tmp:E,dst:h+'/app.json'});
}
if(c){
for(var s=0;s<d.length;s++){
try{FS.deleteFile(d[s].tmp);}catch(e3){}
}
return false;
}
for(var r=0;r<d.length;r++){
if(!FS.renameFile(d[r].tmp,d[r].dst))return false;
}
return true;
},







zipBlob:function(W,H,Q,F){
if(typeof System.installZip!=='function')return null;
var m='/local/kit_install.zip';
var x=false;
try{
x=!!Net.download(W,m,function(P,V){
if(F)F(P,V);
});
}catch(e){x=false;}
if(!x||A.fsx.md5(m)!==Q){
try{FS.deleteFile(m);}catch(e2){}
return false;
}
var t=null;
try{t=System.installZip(m,A.path.safeName(H));}catch(e3){t=null;}
try{FS.deleteFile(m);}catch(e4){}
return!!(t&&t.ok);
}
};

A._mods.push('fsx');

module.exports=A;
