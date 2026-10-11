// ======================================================================
// MONITOR DE ERROS
// Registra na aba "Log_Erros" da planilha tudo o que der errado no app:
//  - erros de JavaScript na tela
//  - chamadas ao Apps Script que falharam (sem resposta, resposta inválida
//    ou resposta com { ok: false })
// Não muda nada do que a pessoa vê. Se o próprio registro falhar, é ignorado.
//
// Uso: <script src="monitor-erros.js" data-app="Nome do app"></script>
// (colocar logo depois do config.js, antes dos outros scripts)
// ======================================================================
(function () {
  if (window.__monitorErros) return;
  window.__monitorErros = true;

  var scriptAtual = document.currentScript;
  var APP = (scriptAtual && scriptAtual.getAttribute('data-app')) || document.title || 'App';
  var MAX_POR_SESSAO = 25;      // evita encher a planilha se algo entrar em loop
  var JANELA_REPETIDO = 60000;  // o mesmo erro só é registrado 1x por minuto
  var enviados = 0;
  var ultimos = {};
  var fetchOriginal = window.fetch ? window.fetch.bind(window) : null;

  function urlApi() { try { return typeof API_URL !== 'undefined' ? API_URL : ''; } catch (e) { return ''; } }

  function usuaria() {
    try {
      var s = JSON.parse(localStorage.getItem('ellba_sessao') || 'null');
      if (s && s.nome) return s.nome;
    } catch (e) {}
    return '';
  }

  function cortar(txt, n) {
    txt = txt === undefined || txt === null ? '' : String(txt);
    return txt.length > n ? txt.slice(0, n) + '…' : txt;
  }

  function registrar(onde, acao, erro, detalhes) {
    try {
      if (!fetchOriginal || !urlApi()) return;
      if (navigator.onLine === false) return; // sem internet não é erro do app
      var chave = onde + '|' + acao + '|' + erro;
      var agora = Date.now();
      if (ultimos[chave] && agora - ultimos[chave] < JANELA_REPETIDO) return;
      ultimos[chave] = agora;
      if (++enviados > MAX_POR_SESSAO) return;

      var corpo = {
        action: 'logErro',
        app: APP,
        onde: onde,
        acao: cortar(acao, 80),
        erro: cortar(erro, 300),
        detalhes: cortar(detalhes, 500),
        usuaria: usuaria(),
        aparelho: cortar(navigator.userAgent, 120),
        tela: cortar(location.pathname + location.search + location.hash, 150)
      };
      try { if (typeof CHAVE_API !== 'undefined') corpo.chave = CHAVE_API; } catch (e) {}

      fetchOriginal(urlApi(), {
        method: 'POST',
        mode: 'no-cors',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(corpo)
      }).catch(function () {});
    } catch (e) {}
  }
  window.registrarErroApp = registrar;

  // ---- erros de JavaScript na tela ----
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return; // erro de carregar imagem/arquivo: ignora
    if (/Script error\.?$/i.test(ev.message)) return; // erro de script de outro site, sem detalhes
    registrar('tela', 'erro de JavaScript', ev.message,
      (ev.filename || '').split('/').pop() + ':' + (ev.lineno || '') + ':' + (ev.colno || ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var msg = r && r.message ? r.message : String(r);
    if (/abort/i.test(msg)) return; // tempo esgotado já é tratado pelo app
    registrar('tela', 'promessa sem tratamento', msg, r && r.stack ? r.stack.split('\n')[1] : '');
  });

  // ---- chamadas ao Apps Script ----
  function nomeAcao(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var m = url.match(/[?&]action=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      if (init && typeof init.body === 'string') {
        var b = JSON.parse(init.body);
        if (b && b.action) return b.action;
      }
    } catch (e) {}
    return '(sem nome)';
  }

  if (fetchOriginal) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var api = urlApi();
      var ehApi = api && url.indexOf(api) === 0;
      var p = fetchOriginal(input, init);
      if (!ehApi) return p;
      var acao = nomeAcao(input, init);
      if (acao === 'logErro') return p;
      var inicio = Date.now();
      return p.then(function (resp) {
        try {
          if (!resp.ok && resp.type !== 'opaque') {
            registrar('servidor', acao, 'HTTP ' + resp.status, '');
          } else if (resp.type !== 'opaque') {
            resp.clone().text().then(function (txt) {
              var j = null;
              try { j = JSON.parse(txt); } catch (e) {
                if (/<html/i.test(txt)) registrar('servidor', acao, 'Apps Script devolveu uma página em vez de dados', cortar(txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 300));
                return;
              }
              if (j && j.ok === false) registrar('resposta', acao, j.erro || j.error || j.mensagem || 'ok=false', '');
              var ms = Date.now() - inicio;
              if (ms > 15000) registrar('lentidão', acao, 'resposta demorou ' + Math.round(ms / 1000) + 's', '');
            }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      }, function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (err && err.name === 'AbortError') registrar('lentidão', acao, 'tempo esgotado (sem resposta)', '');
        else registrar('conexão', acao, msg, '');
        throw err;
      });
    };
  }
})();
