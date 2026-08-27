// ======================================================================
// CAMADA DE COMPATIBILIDADE
// Recria um "google.script.run" falso que na verdade conversa com o
// Apps Script via fetch() comum, para que o resto do código (copiado
// do app original) não precisasse ser reescrito função por função.
// ======================================================================

const ACOES_GET = [
  'buscarProdutos',
  'buscarListaProdutosResumida',
  'buscarProdutoConsulta',
  'carregarListaClientes',
  'carregarListaFornecedores',
  'buscarCategoriasPorLoja',
  'buscarProdutosParaInventario',
  'buscarProdutosMarketing'
];

// Nome do parâmetro de cada ação GET que recebe 1 argumento simples
const PARAM_NOME_GET = {
  buscarProdutoConsulta: 'idProduto',
  buscarCategoriasPorLoja: 'loja'
};

function chamarApi(action, args) {
  if (ACOES_GET.indexOf(action) > -1) {
    let url = API_URL + "?action=" + encodeURIComponent(action) + "&chave=" + encodeURIComponent(CHAVE_API);

    if (action === 'buscarProdutosParaInventario') {
      // 2 argumentos simples: (loja, categoria)
      url += "&loja=" + encodeURIComponent(args[0]) + "&categoria=" + encodeURIComponent(args[1]);
    } else if (args.length > 0 && args[0] !== undefined) {
      const nomeParam = PARAM_NOME_GET[action] || 'valor';
      url += "&" + nomeParam + "=" + encodeURIComponent(args[0]);
    }
    return fetch(url).then(function(r) { return r.json(); });
  }

  // Ações de escrita (POST). Cada função original recebia 1 objeto
  // "dados" (ou um objeto de imagem no caso de salvarImagemNoDrive).
  const payload = { action: action, chave: CHAVE_API };
  if (action === 'salvarImagemNoDrive') {
    payload.imagem = args[0];
  } else {
    payload.dados = args[0];
  }
  return fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  }).then(function(r) { return r.json(); });
}

// Cria um "executor" encadeável: run.withSuccessHandler(a).withFailureHandler(b).minhaFuncao(x)
function criarExecutor(onSuccess, onFailure) {
  const executor = {
    withSuccessHandler: function(cb) { return criarExecutor(cb, onFailure); },
    withFailureHandler: function(cb) { return criarExecutor(onSuccess, cb); }
  };

  // Qualquer outro nome chamado em "executor.NOME(args)" vira uma chamada de API.
  return new Proxy(executor, {
    get: function(target, propName) {
      if (propName in target) return target[propName];

      return function() {
        const args = Array.prototype.slice.call(arguments);
        chamarApi(propName, args).then(function(resp) {
          if (resp && resp.ok) {
            if (onSuccess) onSuccess(resp.data);
          } else {
            const erro = new Error((resp && resp.erro) || 'Erro desconhecido');
            if (onFailure) onFailure(erro);
            else console.error('Erro API (' + propName + '):', erro.message);
          }
        }).catch(function(erro) {
          if (onFailure) onFailure(erro);
          else console.error('Erro de rede (' + propName + '):', erro);
        });
      };
    }
  });
}

window.google = window.google || {};
window.google.script = window.google.script || {};
window.google.script.run = criarExecutor(null, null);
