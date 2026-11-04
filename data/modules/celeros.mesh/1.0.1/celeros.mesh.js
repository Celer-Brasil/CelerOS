




















var a={version:'1.0.1'};


a.available=function(){
return typeof CelerNet!=="undefined"&&typeof Pack!=="undefined";
};


a.active=function(){
return a.available()&&CelerNet.status().active;
};




a.gate=function(f,b){
b=b||{};
if(a.active())return true;
var T=System.theme();
if(a.available()){
UI.card(10,56,220,100);
UI.text(f||"Ligue a malha (app Matilha) para falar com os aparelhos ao redor.",
22,70,{w:196,lines:4});
UI.cardEnd();
if(UI.button("Ligar a malha",10,168,220,36)){
if(!CelerNet.start({}))UI.toast(b.noRam||"Sem RAM para o rádio agora");
}
}else{
UI.card(10,56,220,90);
UI.text("Esta placa não tem Bluetooth no firmware.",22,70,{w:196,lines:3});
UI.cardEnd();
}
return false;
};


a.me=function(){
if(!a._me)a._me=Pack.me();
return a._me;
};



a.each=function(e,g){
var n=0,m;
while((m=CelerNet.poll())!==null){
e(m,g);
n++;
}
return n;
};

module.exports=a;
