"""Gera as tabelas JSON usadas pelo NotaVez a partir dos anexos OFICIAIS do
Portal Nacional da NFS-e (gov.br/nfse -> Documentação técnica).

Uso (requer openpyxl):
  python3 scripts/atualizar_tabelas.py ANEXO_A.xlsx ANEXO_B.xlsx ANEXO_I.xlsx

Saída em src/data/: municipios.json e servicos-nacionais.json, com a versão
dos anexos registrada em src/data/versoes.json. Rode novamente sempre que o
portal publicar novos anexos (regras e leiautes atualizáveis sem mudar código).
"""
import json, os, re, sys
import openpyxl

anexo_a, anexo_b, anexo_i = sys.argv[1:4]
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'data')

def rows(path, sheet):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet in wb.sheetnames else next(s for s in wb.worksheets if s.title.strip() == sheet.strip())
    return list(ws.iter_rows(values_only=True))

# Municípios (Anexo A)
# A coluna de UF da planilha oficial vem incompleta; a UF é derivada dos
# 2 primeiros dígitos do código IBGE (código da unidade da federação).
UF_IBGE = {'11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI',
           '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES',
           '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF'}
mun = []
for r in rows(anexo_a, 'TAB.MUN_IBGE')[1:]:
    if r[3]:
        ibge = str(r[3]).zfill(7)
        mun.append({'ibge': ibge, 'nome': str(r[2]).strip(), 'uf': UF_IBGE[ibge[:2]]})
mun.sort(key=lambda m: (m['uf'], m['nome']))

# Lista nacional de serviços (Anexo B) + incidência e grupos exigidos (Anexo I)
itens = {}
servicos = {}
for r in rows(anexo_b, 'LISTA.SERV.NAC.')[1:]:
    cod, item, sub, desd, desc = r[:5]
    if desc is None:
        continue
    desc = re.sub(r'\s+', ' ', str(desc)).strip()
    if cod is None or str(cod) == 'None':
        if str(sub) == '0':
            itens[str(item)] = desc
        continue
    c = str(cod).zfill(6)
    servicos[c] = {'codigo': c, 'descricao': desc, 'item': itens.get(str(item), '')}

for r in rows(anexo_i, 'MUN.INCID_INFO.SERV.')[4:]:
    if not r[0]:
        continue
    c = str(r[0]).zfill(6)
    if c not in servicos:
        continue
    ep, lp, et = (str(x or '') for x in r[2:5])
    servicos[c]['incidencia'] = 'EP' if 'X' in ep else 'LP' if 'X' in lp else 'ET' if 'X' in et else 'OUTRO'
    grupo = str(r[6] or '-').strip()
    servicos[c]['grupoExigido'] = grupo if grupo in ('obra', 'atvEvento') else None

lista = sorted(servicos.values(), key=lambda s: s['codigo'])
json.dump(mun, open(os.path.join(out, 'municipios.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
json.dump(lista, open(os.path.join(out, 'servicos-nacionais.json'), 'w'), ensure_ascii=False, indent=0)
json.dump({'anexoA': os.path.basename(anexo_a), 'anexoB': os.path.basename(anexo_b), 'anexoI': os.path.basename(anexo_i)},
          open(os.path.join(out, 'versoes.json'), 'w'), ensure_ascii=False, indent=2)
print(len(mun), 'municípios;', len(lista), 'serviços')
