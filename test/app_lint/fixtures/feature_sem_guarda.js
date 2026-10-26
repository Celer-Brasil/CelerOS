// Fixture: uso SEM protecao avisa — raiz opcional usada crua (o aparelho
// sem o recurso derrubaria o app) e funcao acima da API declarada sem
// typeof (o app seria instalado em firmware que nao a tem).
// appInfo do runner: {api: 2, permissions: ["system"]} — a permissao esta
// concedida de proposito, para sobrarem os avisos de nivel/feature.
System.factoryReset(0);
CelerNet.broadcast("x", 6);
Pack.send("pc", { eco: true });
Mic.start();
