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
  'buscarProdutosMarketing',
  'buscarNomesDisponiveis',
  'buscarVendedoras',
  'buscarPecasACaminho',
  'gerarRelatorio',
  'buscarClienteDetalhe',
  'buscarMinhasVendas',
  'buscarAniversariantesHoje',
  'buscarOpcoesProdutoCadastro',
  'buscarDetalheVenda',
  'buscarPedidosCatalogo'
];

// Nome do parâmetro de cada ação GET que recebe 1 argumento simples
const PARAM_NOME_GET = {
  buscarProdutoConsulta: 'idProduto',
  buscarCategoriasPorLoja: 'loja',
  buscarClienteDetalhe: 'idCliente',
  buscarDetalheVenda: 'idVenda',
  buscarPedidosCatalogo: 'status'
};

// ---- Leituras com cópia no celular: ttl = por quanto tempo a cópia é usada na hora (sem esperar a internet) ----
const LEITURAS_LOCAIS = {
  buscarListaProdutosResumida: 120000, carregarListaClientes: 120000, buscarVendedoras: 600000, buscarNomesDisponiveis: 600000,
  buscarOpcoesProdutoCadastro: 600000, carregarListaFornecedores: 600000, buscarCategoriasPorLoja: 300000, buscarPecasACaminho: 120000,
  buscarProdutos: 60000, buscarProdutoConsulta: 30000, buscarDetalheVenda: 60000, buscarAniversariantesHoje: 600000,
  buscarProdutosParaInventario: 0, buscarMinhasVendas: 0, buscarClienteDetalhe: 0
};

// O que devolver ao app quando a operação ficou guardada para enviar depois
function respostaProvisoria(op) {
  switch (op.action) {
    case 'registrarVendaEmLote':
    case 'cadastrarCliente':
    case 'cadastrarPecaACaminho': return op.placeholder;
    case 'cadastrarProduto': return { id: op.placeholder };
    case 'registrarTransferenciaEstoque': return { idDestino: '(gerado ao enviar)' };
    case 'darEntradaPecaACaminho': return { diferenca: 0, idGerado: '(gerado ao enviar)' };
  }
  return true;
}

function avisarFila() { try { window.dispatchEvent(new CustomEvent('ellba-fila')); } catch (e) {} }

function erroRede(e) { return !(e && e.__negocio); }

function montarUrlGet(action, args) {
  let url = API_URL + "?action=" + encodeURIComponent(action) + "&chave=" + encodeURIComponent(CHAVE_API);
  if (action === 'buscarProdutosParaInventario') {
    url += "&loja=" + encodeURIComponent(args[0]) + "&categoria=" + encodeURIComponent(args[1]);
  } else if (action === 'gerarRelatorio') {
    url += "&dataInicio=" + encodeURIComponent(args[0]) + "&dataFim=" + encodeURIComponent(args[1]);
  } else if (action === 'buscarMinhasVendas') {
    url += "&usuaria=" + encodeURIComponent(args[0]) + "&perfil=" + encodeURIComponent(args[1]) + "&dataInicio=" + encodeURIComponent(args[2]) + "&dataFim=" + encodeURIComponent(args[3]) + "&vendedoraFiltro=" + encodeURIComponent(args[4] || '');
  } else if (args.length > 0 && args[0] !== undefined) {
    const nomeParam = PARAM_NOME_GET[action] || 'valor';
    url += "&" + nomeParam + "=" + encodeURIComponent(args[0]);
  }
  return url;
}

function lerDaRede(url, ms) {
  return ellbaFetch(url, {}, ms).then(function(r) { return r.json(); });
}

function chamarApi(action, args) {
  // ---------------- LEITURAS ----------------
  if (ACOES_GET.indexOf(action) > -1) {
    if (args.some(function(a) { return typeof a === 'string' && a.indexOf('PENDENTE-') === 0; })) {
      return Promise.reject(Object.assign(new Error('Ainda aguardando envio ao sistema.'), { __negocio: true }));
    }
    const url = montarUrlGet(action, args);
    if (!(action in LEITURAS_LOCAIS)) {
      return lerDaRede(url, 60000).catch(function(e) {
        throw new Error(navigator.onLine === false ? 'Sem internet no momento.' : 'A internet está muito lenta. Tente de novo.');
      });
    }
    const ttl = LEITURAS_LOCAIS[action];
    const chaveCache = action + '|' + JSON.stringify(args);
    return ellbaGet('cache', chaveCache).then(function(c) {
      const idade = c ? Date.now() - c.ts : Infinity;
      const salvar = function(resp) {
        if (resp && resp.ok) ellbaPut('cache', chaveCache, { k: chaveCache, ts: Date.now(), resp: resp });
        return resp;
      };
      if (c && ttl > 0 && idade < ttl) {
        // cópia recente: responde na hora e atualiza por trás
        if (navigator.onLine !== false) lerDaRede(url, 30000).then(salvar).catch(function() {});
        return c.resp;
      }
      return lerDaRede(url, c ? 7000 : 40000).then(salvar).catch(function(e) {
        if (c) return c.resp; // sem sinal: usa a última cópia
        throw new Error(navigator.onLine === false ? 'Sem internet e esta tela ainda não foi aberta com internet neste celular.' : 'A internet está muito lenta. Tente de novo.');
      });
    });
  }

  // ---------------- ESCRITAS ----------------
  const payload = { action: action, chave: CHAVE_API };
  if (action === 'salvarImagemNoDrive') {
    payload.imagem = args[0];
  } else {
    payload.dados = args[0] || {};
    if (typeof payload.dados === 'object' && payload.dados.usuaria === undefined) {
      payload.dados.usuaria = (typeof window !== 'undefined' && window.usuariaAtual) || '';
    }
  }

  if (ELLBA_ACOES_OFFLINE.indexOf(action) > -1) {
    // 1) guarda no celular ANTES de tentar enviar (se o celular desligar, não perde)
    return ellbaEnfileirar(action, payload).then(function(op) {
      avisarFila();
      // 2) tenta enviar agora, sem travar a vendedora se o sinal estiver ruim
      const tentar = (navigator.onLine === false) ? Promise.reject(new Error('offline')) : ellbaEnviarOp(op);
      return tentar.then(function(resp) {
        if (resp && resp.ok) {
          return ellbaRegistrarMapa(op, resp.data).then(function() { return ellbaDel('fila', op.opId); }).then(function() {
            invalidarLeiturasLocais(); avisarFila(); return resp;
          });
        }
        // erro de regra (ex.: dado inválido): não fica na fila
        return ellbaDel('fila', op.opId).then(function() { avisarFila(); return resp; });
      }).catch(function() {
        // sem rede ou lenta demais: fica guardada e o app segue em frente
        invalidarLeiturasLocais(); agendarEnvioFila(); avisarFila();
        return { ok: true, data: respostaProvisoria(op), offline: true };
      });
    });
  }

  // demais escritas: precisam de internet e de códigos reais
  if (JSON.stringify(payload).indexOf('PENDENTE-') > -1) {
    return Promise.reject(Object.assign(new Error('Esta peça/venda ainda está aguardando envio ao sistema. Tente depois que a fila for enviada.'), { __negocio: true }));
  }
  return ellbaFetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) }, 45000)
    .then(function(r) { return r.json(); })
    .catch(function() { throw new Error(navigator.onLine === false ? 'Sem internet no momento. Esta ação precisa de internet.' : 'A internet está muito lenta. Tente de novo.'); });
}

function invalidarLeiturasLocais() {
  return ellbaTodos('cache').then(function(l) {
    return Promise.all(l.map(function(c) { if (c && c.k) { c.ts = 0; return ellbaPut('cache', c.k, c); } }));
  }).catch(function() {});
}

// ---------------- envio automático da fila ----------------
let _timerFila = null;
function agendarEnvioFila() {
  if (_timerFila) return;
  _timerFila = setInterval(function() { sincronizarAgora(true); }, 30000);
  try { navigator.serviceWorker.ready.then(function(reg) { if (reg.sync) reg.sync.register('ellba-sync'); }).catch(function() {}); } catch (e) {}
}
function sincronizarAgora(silencioso) {
  if (navigator.onLine === false) { avisarFila(); return Promise.resolve({ enviados: 0 }); }
  return ellbaSincronizar().then(function(r) {
    if (r.enviados) invalidarLeiturasLocais();
    avisarFila();
    return ellbaResumoFila().then(function(res) {
      if (!res.pendentes && _timerFila) { clearInterval(_timerFila); _timerFila = null; }
      ellbaPing(window.usuariaAtual);
      r.restantes = res.pendentes; r.erros = res.erros;
      try { window.dispatchEvent(new CustomEvent('ellba-sync-fim', { detail: r })); } catch (e) {}
      return r;
    });
  });
}
window.addEventListener('online', function() { sincronizarAgora(true); });
document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') sincronizarAgora(true); });
window.addEventListener('load', function() {
  ellbaResumoFila().then(function(r) { if (r.pendentes) agendarEnvioFila(); avisarFila(); });
  setTimeout(function() { sincronizarAgora(true); }, 1500);
  // acorda o servidor enquanto a vendedora digita o login (evita a demora da "partida a frio")
  try { fetch(API_URL + '?action=ping').catch(function() {}); } catch (e) {}
});
// mensagem vinda do service worker (envio em segundo plano no Android)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(ev) { if (ev.data === 'ellba-sync') sincronizarAgora(true); });
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
            if (resp && resp.erroDetalhe) erro.message += '\n\n[DEBUG] ' + resp.erroDetalhe;
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