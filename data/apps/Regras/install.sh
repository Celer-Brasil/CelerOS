# Regras (API 42): semeia as regras de exemplo no dado do app — o script
# roda 1x por versao, restrito a esta pasta e ao /local/data/<pkg>.
# Nao sobrescreve regras do dono (so cria na 1a vez).
if test -e ../data/celeros.regras/rules.json
then
  echo "regras: o dono ja tem rules.json (mantido)"
else
  echo '{"regras":[{"quando":"porta","notificar":"Porta aberta!"}]}' > ../data/celeros.regras/rules.json
  echo "regras: exemplo semeado"
fi
