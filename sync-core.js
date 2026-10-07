// ======================================================================
// NÚCLEO OFFLINE (usado pela página e pelo service worker)
// - Guarda leituras (listas) e a FILA de operações no IndexedDB do celular.
// - Cada operação ganha um código único (opId): se for enviada duas vezes,
//   o servidor ignora a repetida.
// ======================================================================
var ELLBA_ACOES_OFFLINE = ['registrarVendaEmLote', 'cadastrarCliente', 'cadastrarProduto', 'registrarEntradaEstoque',
  'registrarSaidaEstoque', 'registrarTransferenciaEstoque', 'salvarInventarioItem', 'cadastrarPecaACaminho',
  'darEntradaPecaACaminho', 'editarCliente'];

var ELLBA_DB = { nome: 'ellba-offline', versao: 1, db: null, mem: { cache: {}, fila: {}, mapa: {} } };

function ellbaAbrirDb() {
  if (ELLBA_DB.db) return Promise.resolve(ELLBA_DB.db);
  return new Promise(function(ok) {
    try {
      var req = indexedDB.open(ELLBA_DB.nome, ELLBA_DB.versao);
      req.onupgradeneeded = function() {
        var d = req.result;
        ['cache', 'fila', 'mapa'].forEach(function(n) { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
      };
      req.onsuccess = function() { ELLBA_DB.db = req.result; ok(ELLBA_DB.db); };
      req.onerror = function() { ok(null); };
      req.onblocked = function() { ok(null); };
    } catch (e) { ok(null); }
  });
}
function ellbaIdb(store, modo, fn) {
  return ellbaAbrirDb().then(function(db) {
    if (!db) return fn(null, ELLBA_DB.mem[store]);
    return new Promise(function(ok, falha) {
      var tx = db.transaction(store, modo), st = tx.objectStore(store), res;
      try { res = fn(st, null); } catch (e) { falha(e); return; }
      tx.oncomplete = function() { ok(res && typeof res === 'object' && 'readyState' in res ? res.result : res); };
      tx.onerror = function() { falha(tx.error); };
      tx.onabort = function() { falha(tx.error); };
    });
  });
}
function ellbaGet(store, chave) {
  return ellbaIdb(store, 'readonly', function(st, mem) { return st ? st.get(chave) : mem[chave]; });
}
function ellbaPut(store, chave, valor) {
  return ellbaIdb(store, 'readwrite', function(st, mem) { if (st) st.put(valor, chave); else mem[chave] = valor; });
}
function ellbaDel(store, chave) {
  return ellbaIdb(store, 'readwrite', function(st, mem) { if (st) st.delete(chave); else delete mem[chave]; });
}
function ellbaTodos(store) {
  return ellbaIdb(store, 'readonly', function(st, mem) {
    if (!st) return Object.keys(mem).map(function(k) { return mem[k]; });
    return st.getAll();
  }).then(function(r) { return r || []; });
}

function ellbaNovoId() {
  if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// fetch com limite de tempo (sinal ruim não pode travar o app)
function ellbaFetch(url, opcoes, ms) {
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var t = ctl ? setTimeout(function() { ctl.abort(); }, ms || 20000) : null;
  var o = opcoes || {}; if (ctl) o.signal = ctl.signal;
  return fetch(url, o).then(function(r) { if (t) clearTimeout(t); return r; }, function(e) { if (t) clearTimeout(t); throw e; });
}

// ---------- fila ----------
function ellbaDescrever(action, dados) {
  dados = dados || {};
  switch (action) {
    case 'registrarVendaEmLote': return 'Venda' + (dados.cliente && dados.cliente !== 'Sem Cadastro' ? ' — ' + String(dados.cliente).split(' - ').slice(1, 2).join('') : '') + (dados.itens ? ' (' + dados.itens.length + ' item(ns))' : '');
    case 'cadastrarCliente': return 'Cadastro de cliente — ' + (dados.nome || '');
    case 'cadastrarProduto': return 'Cadastro de produto — ' + (dados.descricao || '');
    case 'registrarEntradaEstoque': return 'Entrada de estoque — ' + (dados.produto || '');
    case 'registrarSaidaEstoque': return 'Saída de estoque — ' + (dados.produto || '');
    case 'registrarTransferenciaEstoque': return 'Transferência — ' + (dados.produto || '');
    case 'salvarInventarioItem': return 'Inventário — ' + (dados.idProduto || dados.id || '');
    case 'cadastrarPecaACaminho': return 'Peça a caminho — ' + (dados.descricao || '');
    case 'darEntradaPecaACaminho': return 'Entrada de peça a caminho — ' + (dados.codigo || '');
    case 'editarCliente': return 'Edição de cliente — ' + (dados.nome || dados.idCliente || '');
  }
  return action;
}

function ellbaEnfileirar(action, payload) {
  var op = { opId: ellbaNovoId(), action: action, payload: payload, criadoEm: Date.now(), tentativas: 0, status: 'pendente', erro: '', descricao: ellbaDescrever(action, payload.dados) };
  op.placeholder = 'PENDENTE-' + op.opId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  return ellbaPut('fila', op.opId, op).then(function() { return op; });
}
function ellbaListarFila() {
  return ellbaTodos('fila').then(function(l) { return l.sort(function(a, b) { return a.criadoEm - b.criadoEm; }); });
}

// Troca códigos provisórios ("PENDENTE-AB12CD") pelos reais, nas operações que ainda estão na fila.
function ellbaAplicarMapa(op) {
  return ellbaTodos('mapa').then(function(lista) {
    if (!lista.length) return op;
    var txt = JSON.stringify(op.payload);
    lista.forEach(function(m) { if (txt.indexOf(m.de) > -1) txt = txt.split(m.de).join(m.para); });
    op.payload = JSON.parse(txt);
    return op;
  });
}
function ellbaRegistrarMapa(op, data) {
  var real = '';
  if (typeof data === 'string') real = data;
  else if (data && typeof data === 'object') real = data.id || data.idGerado || '';
  if (real && op.placeholder) return ellbaPut('mapa', op.placeholder, { de: op.placeholder, para: String(real) });
  return Promise.resolve();
}

function ellbaEnviarOp(op) {
  // foto guardada para enviar depois
  var etapaFoto = Promise.resolve();
  var d = op.payload && op.payload.dados;
  if (d && d.__foto && d.__foto.base64) {
    etapaFoto = fetch(d.__foto.base64).then(function(r) { return r.blob(); }).then(function(blob) {
      var fd = new FormData(); fd.append('file', blob, (d.__foto.nome || 'foto') + '.jpg'); fd.append('upload_preset', CLOUDINARY_PRESET);
      return ellbaFetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd }, 60000);
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (!j || !j.secure_url) throw new Error('rede: foto não enviada');
      d[d.__foto.campo || 'fotoUrl'] = j.secure_url; delete d.__foto;
      return ellbaPut('fila', op.opId, op);
    });
  }
  return etapaFoto.then(function() { return ellbaAplicarMapa(op); }).then(function(op2) {
    var corpo = { action: op2.action, chave: CHAVE_API, dados: op2.payload.dados, opId: op2.opId };
    return ellbaFetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo) }, 30000);
  }).then(function(r) { return r.json(); });
}

var ELLBA_SYNC_RODANDO = false;
// Envia a fila em ordem. Para na primeira falha de rede; erro "de negócio" marca a operação e segue.
function ellbaSincronizar() {
  if (ELLBA_SYNC_RODANDO) return Promise.resolve({ enviados: 0, ocupado: true });
  ELLBA_SYNC_RODANDO = true;
  var enviados = 0;
  function proximo() {
    return ellbaListarFila().then(function(fila) {
      var op = fila.filter(function(o) { return o.status === 'pendente'; })[0];
      if (!op) return;
      op.tentativas++;
      return ellbaEnviarOp(op).then(function(resp) {
        if (resp && resp.ok) {
          return ellbaRegistrarMapa(op, resp.data).then(function() { return ellbaDel('fila', op.opId); }).then(function() { enviados++; return proximo(); });
        }
        op.status = 'erro'; op.erro = (resp && resp.erro) || 'Erro desconhecido';
        return ellbaPut('fila', op.opId, op).then(proximo);
      }).catch(function(e) {
        // sem rede / tempo esgotado: guarda e para (tenta de novo depois)
        return ellbaPut('fila', op.opId, op).then(function() { return; });
      });
    });
  }
  return proximo().then(function() { ELLBA_SYNC_RODANDO = false; return { enviados: enviados }; },
    function() { ELLBA_SYNC_RODANDO = false; return { enviados: enviados }; });
}

function ellbaResumoFila() {
  return ellbaListarFila().then(function(f) {
    var pend = f.filter(function(o) { return o.status === 'pendente'; });
    return { pendentes: pend.length, erros: f.filter(function(o) { return o.status === 'erro'; }).length,
      maisAntiga: pend.length ? pend[0].criadoEm : 0, lista: f };
  });
}

// ---------- aviso ao servidor (para o lembrete diário) ----------
function ellbaPing(usuaria) {
  if (!usuaria) return Promise.resolve();
  return ellbaResumoFila().then(function(r) {
    return ellbaFetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'pingSync', chave: CHAVE_API, dados: { usuaria: usuaria, pendentes: r.pendentes, erros: r.erros, maisAntiga: r.maisAntiga, aparelho: (self.navigator && navigator.userAgent || '').slice(0, 60) } }) }, 10000);
  }).catch(function() {});
}
