# Choco Kingdom — app (Expo) + API (Node)

Monorepo com **React Native / Expo** (`App.tsx`, EAS) e **backend Express** em `backend/`, ligado a **SQL Server**.

## Correr em desenvolvimento

- **API:** `cd backend && npm install && npm start` (configura `backend/.env` a partir de `backend/.env.example`).
- **App:** na raiz, `npm install` e `npx expo start`.

Para builds nativos, ver `app.config.js` e a variável **`EXPO_PUBLIC_API_URL`** (URL da API no momento do build).

## Portfolio: GitHub e acesso de qualquer sítio

O APK/APK de preview **embute** o URL da API. Para mostrar o trabalho **fora de casa**, precisas de uma **API pública** (idealmente HTTPS) e de um **novo build** com `EXPO_PUBLIC_API_URL` apontando para esse URL.

Guia passo a passo: **[docs/PORTFOLIO_DEPLOY.md](docs/PORTFOLIO_DEPLOY.md)**.

## Documentação para visitantes do repositório

- **Fluxo do app em linguagem simples** (visitante vs funcionário, abas, mapa, perfil): **[docs/FLUXO_APP_LEIGOS.md](docs/FLUXO_APP_LEIGOS.md)**  
- Prints de ecrã: coloque os PNG em **[docs/imagens-fluxo/](docs/imagens-fluxo/README.md)** (ou use `scripts/copiar-prints-fluxo.ps1`) para as imagens aparecerem no guia no GitHub.
- Detalhe técnico e stack: **[docs/DOCUMENTACAO_PROJETO_CACAU_APP.md](docs/DOCUMENTACAO_PROJETO_CACAU_APP.md)**.

## Segurança no Git

- Não commits: `.env`, `backend/.env`, chaves, passwords.
- Usa `backend/.env.example` e variáveis no painel da Expo / do teu hosting.
