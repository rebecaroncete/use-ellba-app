// ======================================================================
// MELHORIAS DE CONEXÃO (app interno USE ELLBA)
// Carregar DEPOIS do api.js. Não altera os outros arquivos.
//  1) Tenta de novo sozinho quando o servidor responde 404/erro ou a rede falha (2 tentativas por chamada)
//  2) Aviso do pingSync mais leve (no máximo 1 vez a cada 15 min, se nada mudou)
//  3) Aviso na tela quando está sem internet ou com conexão instável
//  4) Tela de marketing passa a abrir na hora com a cópia do celular
//  5) "Atualizar dados": uma lista por vez, mais paciência, e só repete o que faltou
// ======================================================================
(function() {
  'use strict';

  // ---------- 3) faixa de aviso ----------
  var faixa = null, timerFaixa = null;
  function mostrarFaixa(texto, cor, ms) {
    try {
      if (!document.body) return;
      if (!faixa) {
        faixa = document.createElement('div');
        faixa.setAttribute('role', 'status');
        faixa.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:8px 12px;font:600 13px/1.3 system-ui,sans-serif;text-align:center;color:#fff;';
        document.body.appendChild(faixa);
      }
      faixa.textContent = texto; faixa.style.background = cor; faixa.style.display = 'block';
      if (timerFaixa) clearTimeout(timerFaixa);
      if (ms) timerFaixa = setTimeout(esconderFaixa, ms);
    } catch (e) {}
  }
  function esconderFaixa() { if (faixa) faixa.style.display = 'none'; }
  function avisoSemInternet() { mostrarFaixa('Sem internet. As vendas ficam guardadas no celular e são enviadas quando a conexão voltar.', '#8a5a00'); }
  window.addEventListener('offline', avisoSemInternet);
  window.addEventListener('online', function() { mostrarFaixa('Conexão voltou.', '#2e7d32', 3000); });
  window.addEventListener('load', function() { if (navigator.onLine === false) avisoSemInternet(); });

  // ---------- 1) tentar de novo ----------
  var fetchOriginal = window.fetch.bind(window);
  var ESPERAS = [1500];                       // 2 tentativas no total (o botão Atualizar dados repete por conta própria)
  var STATUS_REPETIR = { 404: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

  function ehApi(url) {
    try { return typeof API_URL !== 'undefined' && API_URL && String(url).indexOf(API_URL) === 0; } catch (e) { return false; }
  }
  function abortado(init) { return !!(init && init.signal && init.signal.aborted); }
  function pausar(ms) { return new Promise(function(ok) { setTimeout(ok, ms); }); }
  function erroAbortado() { var e = new Error('Aborted'); e.name = 'AbortError'; return e; }

  // pode repetir sem risco de duplicar?  Leitura: sim. Escrita com opId: sim (servidor ignora repetida).
  // Escrita sem opId: só se o servidor respondeu 404 (nem chegou a rodar).
  function corpoTemOpId(init) {
    try { return !!(init && typeof init.body === 'string' && init.body.indexOf('"opId"') > -1); } catch (e) { return false; }
  }

  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (!ehApi(url)) return fetchOriginal(input, init);
    var metodo = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var seguro = metodo === 'GET' || corpoTemOpId(init);

    function tentar(n) {
      return fetchOriginal(input, init).then(function(r) {
        if (STATUS_REPETIR[r.status] && n < ESPERAS.length + 1 && !abortado(init) && (seguro || r.status === 404)) {
          mostrarFaixa('Conexão instável, tentando de novo…', '#8a5a00');
          return pausar(ESPERAS[n - 1]).then(function() { if (abortado(init)) throw erroAbortado(); return tentar(n + 1); });
        }
        if (n > 1 && r.ok) esconderFaixa();
        return r;
      }, function(e) {
        var cancelado = (e && e.name === 'AbortError') || abortado(init);
        if (!cancelado && seguro && n < ESPERAS.length + 1 && navigator.onLine !== false) {
          mostrarFaixa('Conexão instável, tentando de novo…', '#8a5a00');
          return pausar(ESPERAS[n - 1]).then(function() { if (abortado(init)) throw erroAbortado(); return tentar(n + 1); });
        }
        if (n > 1 && navigator.onLine !== false) esconderFaixa();
        throw e;
      });
    }
    return tentar(1);
  };

  // ---------- 2) pingSync mais leve ----------
  try {
    if (typeof ellbaPing === 'function' && typeof ellbaResumoFila === 'function') {
      var pingOriginal = ellbaPing, ultimo = { t: 0, pend: -1, erros: -1 };
      ellbaPing = function(usuaria) {
        if (!usuaria) return Promise.resolve();
        if (document.visibilityState === 'hidden' || navigator.onLine === false) return Promise.resolve();
        return ellbaResumoFila().then(function(r) {
          var mudou = r.pendentes !== ultimo.pend || r.erros !== ultimo.erros;
          if (!mudou && Date.now() - ultimo.t < 15 * 60 * 1000) return;
          ultimo = { t: Date.now(), pend: r.pendentes, erros: r.erros };
          return pingOriginal(usuaria);
        }).catch(function() {});
      };
    }
  } catch (e) {}


  // ---------- 5) "Atualizar dados" mais gentil com Wi-Fi fraco ----------
  // Baixa UMA lista de cada vez (antes eram 3 juntas), espera mais por lista, tenta até 3 vezes com pausa,
  // e quando se toca de novo só baixa o que falta (listas baixadas há menos de 2 minutos são puladas).
  try {
    if (typeof atualizarListasDoCelular === 'function' && typeof LISTAS_ATUALIZAR !== 'undefined') {
      var ocupado = false;
      atualizarListasDoCelular = function(opcoes) {
        opcoes = opcoes || {};
        if (ocupado) return Promise.resolve({ ocupado: true, falhas: [], mudou: false });
        if (navigator.onLine === false) return Promise.resolve({ semInternet: true, falhas: [], mudou: false });
        ocupado = true;
        var resultado = { falhas: [], mudou: false, enviados: 0 };
        var feitos = 0, total = LISTAS_ATUALIZAR.length;
        var progresso = function(nome) { if (opcoes.onProgresso) opcoes.onProgresso(feitos, total, nome); };

        var etapaFila = ellbaResumoFila().then(function(r) {
          if (!r.pendentes) return;
          if (opcoes.onProgresso) opcoes.onProgresso(0, total, 'Enviando vendas pendentes');
          return ellbaSincronizar().then(function(x) { resultado.enviados = x.enviados || 0; });
        }).catch(function() {});

        var PAUSAS = [2000, 5000];
        function baixar(item) {
          var nome = item[0], action = item[1], args = item[2];
          var url = montarUrlGet(action, args), chave = action + '|' + JSON.stringify(args);
          progresso(nome);
          function tentar(n) {
            return lerDaRede(url, 45000).then(function(resp) {
              if (!(resp && resp.ok)) throw new Error((resp && resp.erro) || 'erro');
              return resp;
            }).catch(function(e) {
              if (n <= PAUSAS.length && navigator.onLine !== false) return pausar(PAUSAS[n - 1]).then(function() { return tentar(n + 1); });
              throw e;
            });
          }
          return ellbaGet('cache', chave).then(function(anterior) {
            if (anterior && anterior.resp && anterior.resp.ok && Date.now() - anterior.ts < 120000) return; // já está fresca
            return tentar(1).then(function(resp) {
              var antes = anterior && anterior.resp && JSON.stringify(anterior.resp.data);
              if (antes !== JSON.stringify(resp.data)) resultado.mudou = true;
              return ellbaPut('cache', chave, { k: chave, ts: Date.now(), resp: resp });
            });
          }).catch(function() { resultado.falhas.push(nome); }).then(function() { feitos++; progresso(nome); });
        }

        return etapaFila.then(function() {
          return LISTAS_ATUALIZAR.reduce(function(p, item) { return p.then(function() { return baixar(item); }); }, Promise.resolve());
        }).then(function() {
          ocupado = false;
          if (!resultado.falhas.length) { try { localStorage.setItem('ellba_dados_ts', String(Date.now())); } catch (e) {} }
          if (resultado.mudou) { try { window.dispatchEvent(new CustomEvent('ellba-dados-novos', { detail: 'tudo' })); } catch (e) {} }
          try { avisarFila(); } catch (e) {}
          return resultado;
        }, function(e) { ocupado = false; throw e; });
      };
    }
  } catch (e) {}

  // ---------- 4) marketing abre na hora com a cópia do celular ----------
  try { if (typeof LEITURAS_LOCAIS === 'object' && !('buscarProdutosMarketing' in LEITURAS_LOCAIS)) LEITURAS_LOCAIS.buscarProdutosMarketing = 60000; } catch (e) {}
})();
