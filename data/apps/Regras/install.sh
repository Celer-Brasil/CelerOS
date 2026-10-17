# Regras (API 42): semeia as regras de exemplo no dado do app — o script
# roda 1x por versao, restrito a esta pasta e ao /local/data/<pkg>.
# Caminho ABSOLUTO do appData: o shell restrito libera a pasta do app e
# /local/data/<pkg>; relativo ("../data/...") caia em /local/apps/data (ou
# /sd/data, com o app no SD) e a escrita era negada — o servico ficava sem
# rules.json e o marcador de setup nunca fechava.
# Nao sobrescreve regras do dono (so cria na 1a vez).
if test -e /local/data/celeros.regras/rules.json
then
  echo "regras: o dono ja tem rules.json (mantido)"
else
  echo '{"regras":[{"quando":"porta","notificar":"Porta aberta!"}]}' > /local/data/celeros.regras/rules.json
  echo "regras: exemplo semeado"
fi
