# Portfolio e acesso em qualquer lugar (GitHub + demo)

## O que precisa existir

1. **Repositório no GitHub** — código versionado (sem segredos: sem `backend/.env`, sem `.env` na raiz).
2. **API pública na Internet** — um URL que o telemóvel alcance fora da tua casa (não serve `192.168.x.x`).
3. **Build da app com esse URL** — a variável **`EXPO_PUBLIC_API_URL`** é lida no build (`app.config.js`) e fica **fixa dentro do APK**.

Sem os três, o app instalado continua a apontar para o IP antigo ou para uma rede local.

---

## O teu backend (importante)

- Em casa usas **SQL Server** com **Windows Auth** (`msnodesqlv8`) — típico no PC.
- Na **nuvem (Linux)** o processo Node usa só o driver **`mssql`** (Tedious): define **`DB_USE_WINDOWS_AUTH=false`** e autenticação SQL (**`DB_USER` / `DB_PASSWORD`**), com o servidor apontando para **Azure SQL**, **SQL Server na Azure**, ou outra instância acessível pela Internet.
- **Migrar a base** ou **restaurar** `CacauParque` numa BD na nuvem é um passo à parte (script SQL já tens no repo).

Caminhos razoáveis para entrevista:

| Abordagem | Prós | Contras |
|-----------|------|--------|
| **A — Túnel (Cloudflare Tunnel / ngrok)** no PC com `npm start` no backend | Rápido para uma demo; HTTPS no túnel | PC tem de estar ligado; URL pode mudar no plano grátis |
| **B — API na nuvem + BD hospedada** (ex.: Azure App Service/Container + Azure SQL) | Sempre ligado; profissional | Configuração e custo (free tier limitado) |
| **C — Só vídeo / screenshots** para o portfolio | Zero infra | Não interagem com a app ao vivo |

Para **entrevista**, muitas vezes **A + README com credenciais de demo** chega; para **“abrir em qualquer lugar sempre”**, aponta para **B**.

---

## Passos práticos (resumo)

### 1. GitHub

- Cria o repositório vazio no GitHub.
- No projeto: `git remote add origin ...` e `git push -u origin main` (ou `master`).
- **Nunca faças commit de** `backend/.env`, `.env`, ficheiros `.jks`/keystore, ou passwords.

### 2. URL público da API

- Depois de teres algo como `https://api-teu-projeto.azurewebsites.net` ou `https://xxx.trycloudflare.com` (túnel), esse é o **único** URL que interessa para o telemóvel.

### 3. App (Expo / EAS)

- No **Expo**: *Project → Environment variables* → cria **`EXPO_PUBLIC_API_URL`** = URL público (com `https://` de preferência).
- Em **`eas.json`**, o perfil que usas para o APK pode ter `"env": { "EXPO_PUBLIC_API_URL": "..." }` **ou** confiar só nas variáveis do painel (melhor não guardar produção com IP de casa no Git).
- Gera de novo: `eas build --platform android --profile preview` (ou perfil `production`).

### 4. HTTPS

- **Recomendado** para portfolio e para evitar bloqueios em redes móveis.
- O app já tem `android.usesCleartextTraffic: true` para HTTP; mesmo assim **HTTPS público** é o alvo.

---

## README para entrevistas

No `README.md` sugere-se: stack (Expo, Node, SQL Server), como correr em local, link para este doc, e **como pedir build de demo** (EAS / APK). Opcional: conta de demo só de leitura na BD na nuvem.
