const express = require('express');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/signaling', (req, res) => res.json({ selfHosted: true }));

// ============================================================
// Servidores de conexao (STUN/TURN)
//
// STUN so descobre seu IP publico. Quando os dois lados estao atras de NAT
// restritivo (4G, rede corporativa, CGNAT), a conexao direta nao fecha e e
// preciso um TURN, que retransmite o video. Sem TURN funcionando, essas
// pessoas ficam com a tela preta enquanto as outras assistem normalmente.
//
// O TURN aqui usa credencial assinada com validade (padrao REST do coturn):
// o usuario e "<expira_em>:<nome>" e a senha e o HMAC-SHA1 disso.
// ============================================================
// A configuracao do TURN fica em turn.json (veja turn.example.json).
// Sem esse arquivo o app funciona so com STUN: a maioria conecta, mas quem
// estiver em rede restritiva fica sem imagem.
const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

function loadTurnConfig() {
  // Em servidor hospedado (Render etc) a configuracao vem por variaveis de
  // ambiente: o turn.json tem senha e NAO pode ir pro GitHub.
  if (process.env.TURN_HOST) {
    return {
      host: process.env.TURN_HOST,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
      secret: process.env.TURN_SECRET,
      ports: (process.env.TURN_PORTS || '3478').split(',').map(Number)
    };
  }
  if (process.env.METERED_API_KEY) {
    return { meteredApiKey: process.env.METERED_API_KEY, meteredApp: process.env.METERED_APP };
  }
  // Rodando no seu PC: le o arquivo local.
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'turn.json'), 'utf8'));
  } catch { return null; }
}

// Credencial assinada com validade (padrao REST do coturn):
// usuario = "<expira_em>:<nome>", senha = HMAC-SHA1 do usuario.
function hmacCredentials(secret, ttlSeconds = 6 * 3600) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:bottela`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

async function buildIceServers() {
  const cfg = loadTurnConfig();
  if (!cfg) return { iceServers: STUN_ONLY, turn: false, motivo: 'turn.json não encontrado' };

  // Modo 1: chave da API do metered.ca — ela devolve a lista pronta.
  if (cfg.meteredApiKey && cfg.meteredApp) {
    const url = `https://${cfg.meteredApp}.metered.live/api/v1/turn/credentials?apiKey=${cfg.meteredApiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('metered.ca respondeu ' + r.status);
    return { iceServers: await r.json(), turn: true, modo: 'metered' };
  }

  // Modo 2: servidor proprio com segredo compartilhado.
  if (cfg.host && cfg.secret) {
    const { username, credential } = hmacCredentials(cfg.secret);
    const p = cfg.ports || [3478];
    const urls = [];
    p.forEach(port => {
      urls.push({ urls: `turn:${cfg.host}:${port}`, username, credential });
      urls.push({ urls: `turn:${cfg.host}:${port}?transport=tcp`, username, credential });
    });
    return { iceServers: [...STUN_ONLY, ...urls], turn: true, modo: 'hmac' };
  }

  // Modo 3: usuario e senha fixos.
  if (cfg.host && cfg.username && cfg.credential) {
    const p = cfg.ports || [3478];
    const urls = [];
    p.forEach(port => {
      urls.push({ urls: `turn:${cfg.host}:${port}`, username: cfg.username, credential: cfg.credential });
      urls.push({ urls: `turn:${cfg.host}:${port}?transport=tcp`, username: cfg.username, credential: cfg.credential });
    });
    return { iceServers: [...STUN_ONLY, ...urls], turn: true, modo: 'estatico' };
  }

  return { iceServers: STUN_ONLY, turn: false, motivo: 'turn.json incompleto' };
}

app.get('/api/ice', async (req, res) => {
  try {
    res.json(await buildIceServers());
  } catch (err) {
    console.error('TURN falhou:', err.message);
    res.json({ iceServers: STUN_ONLY, turn: false, motivo: err.message });
  }
});

const server = http.createServer(app);

// ATENCAO: temos DOIS WebSockets no mesmo servidor HTTP — o do PeerJS
// (sinalizacao de video) e o nosso (salas). Se os dois se anexarem sozinhos,
// a lib `ws` derruba com 400 toda conexao que nao for do caminho dela, e um
// mata o outro. Por isso ambos sao criados como `noServer` e nos mesmos
// roteamos os upgrades por caminho, mais abaixo.
const roomWss = new WebSocketServer({ noServer: true });
let peerWss = null;
let peerWsPath = '/peerjs/peerjs';

// Sinalizacao de midia (WebRTC) — propria, pra nao depender do servidor
// publico do PeerJS, que vive sobrecarregado.
const peerServer = ExpressPeerServer(server, {
  path: '/',
  createWebSocketServer: (opts) => {
    peerWsPath = opts.path;
    peerWss = new WebSocketServer({ noServer: true });
    return peerWss;
  }
});
app.use('/peerjs', peerServer);

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/ws') {
    roomWss.handleUpgrade(req, socket, head, (ws) => roomWss.emit('connection', ws, req));
  } else if (peerWss && pathname.startsWith('/peerjs')) {
    peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ============================================================
// Registro de salas
// O servidor so guarda QUEM esta em cada sala e QUEM esta transmitindo.
// O video nunca passa por aqui — vai direto de um usuario pro outro.
// ============================================================
const rooms = new Map(); // codigo -> Map(peerId -> { name, broadcasting, ws })

function listMembers(room) {
  return [...room.entries()].map(([peerId, m]) => ({
    peerId, name: m.name, broadcasting: m.broadcasting, camOn: m.camOn
  }));
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  room.forEach((m, id) => { if (id !== exceptId) sendTo(m.ws, obj); });
}

roomWss.on('connection', (ws) => {
  let myRoom = null;
  let myId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Keepalive da conexao: o cliente manda ping a cada 20s e nos respondemos.
    // Sem trafego, tuneis como o ngrok derrubam a conexao por ociosidade —
    // era uma das causas de "a conexao com o servidor caiu".
    if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }

    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase().trim();
      if (!code || !msg.peerId) return;

      if (!rooms.has(code)) rooms.set(code, new Map());
      const room = rooms.get(code);

      myRoom = code;
      myId = msg.peerId;
      const name = String(msg.name || 'Anônimo').slice(0, 24);
      // Numa RECONEXAO o cliente ja pode estar transmitindo/com camera:
      // ele informa o estado atual pra nao voltar "zerado" pros outros.
      const broadcasting = !!msg.broadcasting;
      const camOn = !!msg.camOn;

      // Manda a lista ANTES de me incluir: sao os que ja estavam la.
      sendTo(ws, { type: 'join-ok', you: myId, room: code, members: listMembers(room) });

      const existed = room.has(myId);
      room.set(myId, { name, broadcasting, camOn, ws });
      broadcast(room, {
        type: existed ? 'member-updated' : 'member-joined',
        member: { peerId: myId, name, broadcasting, camOn }
      }, myId);

      console.log(`[sala ${code}] ${name} ${existed ? 'reconectou' : 'entrou'} (${room.size} na sala)`);
    }

    // Avisa a sala que comecei/parei de transmitir. Usamos isso em vez de
    // confiar so no evento 'close' do WebRTC, que e pouco confiavel.
    if (msg.type === 'broadcast-state' && myRoom) {
      const room = rooms.get(myRoom);
      if (!room) return;
      const me = room.get(myId);
      if (!me) return;
      me.broadcasting = !!msg.on;
      if (!me.broadcasting) me.camOn = false;
      broadcast(room, { type: 'broadcast-state', peerId: myId, on: me.broadcasting }, myId);
    }

    // Camera ligada/desligada. Vai como aviso separado porque a camera e uma
    // faixa de video propria — e isso que deixa cada espectador colocar ela
    // onde quiser sem mexer na tela de ninguem.
    if (msg.type === 'cam-state' && myRoom) {
      const room = rooms.get(myRoom);
      if (!room) return;
      const me = room.get(myId);
      if (!me) return;
      me.camOn = !!msg.on;
      broadcast(room, { type: 'cam-state', peerId: myId, on: me.camOn }, myId);
    }

    // Assinatura sob demanda: ninguem recebe video sem pedir.
    // O espectador avisa "quero ver o fulano" e o servidor repassa pro fulano,
    // que so entao inicia a chamada. E assim que o Discord funciona — voce nao
    // baixa todas as transmissoes da sala, so a que esta olhando.
    if ((msg.type === 'watch' || msg.type === 'unwatch') && myRoom) {
      const room = rooms.get(myRoom);
      const target = room && room.get(msg.target);
      if (target) {
        sendTo(target.ws, {
          type: msg.type === 'watch' ? 'watch-request' : 'unwatch-request',
          from: myId
        });
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    // Numa reconexao rapida, o socket NOVO ja substituiu o meu registro.
    // Se este close e do socket velho, nao pode apagar o novo — senao o
    // usuario reconecta e some da sala mesmo assim (membro fantasma as avessas).
    const atual = room.get(myId);
    if (!atual || atual.ws !== ws) return;
    room.delete(myId);
    broadcast(room, { type: 'member-left', peerId: myId });
    if (room.size === 0) rooms.delete(myRoom);
    console.log(`[sala ${myRoom}] alguem saiu (${room.size} restantes)`);
  });
});

// Limpeza de conexoes mortas: ping de protocolo a cada 30s; quem nao
// responder duas vezes seguidas e desconectado (dispara o close acima,
// que avisa a sala — sem isso, quedas abruptas viram membros fantasmas).
setInterval(() => {
  roomWss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`WebSocket das salas: /ws | sinalizacao PeerJS: ${peerWsPath}`);

  // Avisa logo de cara se o TURN esta valendo — e a causa numero um de
  // "a tela do meu amigo fica preta".
  try {
    const ice = await buildIceServers();
    if (ice.turn) {
      console.log(`TURN ATIVO (modo ${ice.modo}) — quem estiver em rede restrita tambem consegue assistir.`);
    } else {
      console.log('---------------------------------------------------------------');
      console.log('AVISO: sem TURN configurado (' + ice.motivo + ').');
      console.log('A maioria vai conseguir assistir, mas quem estiver em rede');
      console.log('restritiva (4G, rede corporativa) vera a tela preta.');
      console.log('Preencha o arquivo turn.json para resolver.');
      console.log('---------------------------------------------------------------');
    }
  } catch (e) {
    console.log('AVISO: nao consegui validar o TURN:', e.message);
  }

  console.log('Abra essa URL no navegador para criar ou entrar numa sala.');
});
