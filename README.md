# 🖥️ Bot Tela

Aplicação web de **compartilhamento de tela em tempo real** entre amigos, no estilo do "Go Live" do Discord. Cada pessoa entra numa sala com um código, escolhe o que quer transmitir (uma tela, janela ou aba) e os outros assistem direto no navegador, sem instalar nada.

O vídeo vai **direto de um usuário para o outro (P2P, via WebRTC)**. O servidor só organiza as salas e ajuda as conexões a se encontrarem. A imagem nunca passa por ele.

## ✨ Funcionalidades

- 🚪 **Portal de entrada** com logo personalizada e efeitos de brilho
- 🔐 **Senha de entrada** conferida no servidor, com token assinado (HMAC) e bloqueio contra força bruta
- 🚪 **Salas por código**: crie uma sala nova ou entre numa existente
- 📺 **Transmitir a tela** (tela inteira, janela ou aba) para quem estiver na sala, **com áudio**
- 🔄 **Trocar de tela sem parar a transmissão**: quem está assistindo não cai
- 👀 **Assinatura sob demanda**: você só recebe o vídeo de quem escolher assistir, como no Discord
- ⚡ **Bitrate adaptativo**: gasta menos internet quando a tela está parada e volta à qualidade máxima quando há movimento
- 📊 **Limite de 720p** priorizando fluidez, com estatísticas de envio
- 🔊 **Controle de volume** de cada transmissão
- 📹 **Câmera** opcional, em uma faixa de vídeo separada da tela
- 💬 **Chat da sala**, com suporte a links de imagem e GIF
- ⛶ **Tela cheia** e ⧉ **Picture-in-Picture** (a janela fica por cima dos outros programas)
- 🗺️ **Mapa-mundi pontilhado** mostrando de onde cada pessoa da sala está (localização aproximada por IP)
- 🔁 **Reconexão automática** que mantém o estado de quem já estava transmitindo
- 🔧 **Tela de diagnóstico** para testar a conexão e ver erros do servidor

## 🛠️ Tecnologias utilizadas

**Back-end**
- **Node.js**: ambiente de execução
- **Express**: servidor HTTP e rotas da API
- **ws**: WebSocket para as salas, o chat e os avisos em tempo real
- **PeerJS Server**: sinalização própria para o WebRTC
- **dotted-map**: geração do mapa-mundi em SVG

**Front-end**
- **HTML, CSS e JavaScript** puros
- **WebRTC** (`getDisplayMedia` e `getUserMedia`) para capturar e transmitir a tela e a câmera
- **PeerJS** para as conexões P2P

**Infraestrutura**
- **STUN/TURN** para funcionar em redes restritivas (4G, rede corporativa)
- **Render** para hospedagem (`render.yaml`) ou **ngrok** para rodar a partir do próprio PC

## 🚀 Como rodar o projeto

### Pré-requisitos
- [Node.js](https://nodejs.org/) 18 ou superior
- [Git](https://git-scm.com/)

### Passo a passo

1. Clone o repositório:
   ```bash
   git clone https://github.com/samuelcurcelicordovil-collab/bot-tela.git
   ```
2. Entre na pasta:
   ```bash
   cd bot-tela
   ```
3. Instale as dependências:
   ```bash
   npm install
   ```
4. *(Opcional)* Crie um arquivo `senha.txt` com a senha de entrada. Sem ele, o site fica aberto.
5. *(Opcional)* Copie `turn.example.json` para `turn.json` e preencha os dados do seu servidor TURN.
6. Inicie o servidor:
   ```bash
   npm start
   ```
7. Abra **http://localhost:3000** no navegador.

### Atalho no Windows
Dê dois cliques no **`iniciar.bat`**. Ele instala as dependências (na primeira vez), sobe o servidor e abre um túnel do **ngrok**. Depois é só mandar o link `https://xxxx.ngrok-free.app` para os seus amigos.

### Hospedando no Render
O arquivo `render.yaml` já deixa tudo configurado. Basta conectar o repositório no [Render](https://render.com) e preencher as variáveis de ambiente no painel:

| Variável | Para que serve |
|---|---|
| `ROOM_PASSWORD` | Senha de entrada do site |
| `TURN_HOST` | Endereço do servidor TURN |
| `TURN_USERNAME` | Usuário do TURN |
| `TURN_CREDENTIAL` | Senha do TURN |
| `TURN_PORTS` | Portas do TURN (padrão: `3478`) |

> ⚠️ Os arquivos `senha.txt` e `turn.json` guardam segredos e estão no `.gitignore`. Nunca suba eles para o GitHub.

## 📂 Estrutura de pastas

```
bot-tela/
├── public/
│   ├── index.html          # Interface completa (HTML, CSS e JS do cliente)
│   └── lol2-logo*.png      # Logos
├── server.js               # Servidor: API, salas, WebSocket, PeerJS e TURN
├── iniciar.bat             # Atalho para rodar no Windows com ngrok
├── render.yaml             # Configuração de deploy no Render
├── turn.example.json       # Modelo de configuração do TURN
└── package.json            # Dependências e scripts
```

## 🧠 Como funciona

1. O usuário digita a senha e o servidor devolve um **token com validade**.
2. Ele entra numa sala pelo **WebSocket** (`/ws`), e o servidor avisa os outros membros.
3. Quando alguém clica para assistir, o servidor repassa o pedido para quem está transmitindo.
4. Os dois navegadores fecham uma **conexão WebRTC direta** e o vídeo começa a chegar.
5. Se a rede não permitir conexão direta, o **TURN** retransmite o vídeo.

## 📚 O que aprendi

- Como o **WebRTC** funciona na prática: sinalização, STUN, TURN e NAT
- Usar **WebSocket** para comunicação em tempo real
- Fazer **autenticação segura no servidor** com tokens HMAC e comparação resistente a timing attacks
- Tratar erros e quedas do servidor para que ele não caia sem explicação
- Guardar segredos em **variáveis de ambiente** em vez de colocar no código
- Fazer **deploy** de uma aplicação Node.js

## 🔮 Melhorias futuras

- [ ] Escolher a qualidade do vídeo (resolução e FPS)
- [ ] Salas com senhas diferentes
- [ ] Versão para celular

## 👥 Autores

Projeto feito em dupla por:

| | Autor | Principais contribuições |
|---|---|---|
| 🧑‍💻 | **Samuel Cordovil**<br>[@samuelcurcelicordovil-collab](https://github.com/samuelcurcelicordovil-collab) | Estrutura inicial do projeto, servidor e salas, senha de entrada, faixa de câmeras, controle de volume, limite de 720p com estatísticas de envio, caixa-preta e diagnóstico do servidor |
| 🧑‍💻 | **Iago Serafim**<br>[@ashp000](https://github.com/ashp000) | Chat da sala com imagens e GIFs, áudio da transmissão, salas para grupos diferentes, pop-up de webcam, bitrate adaptativo, trocar tela sem parar a transmissão, portal de entrada, efeitos visuais e mapa |
