# Documentação do Projeto — Choco Kingdom

> **Quem chegar ao GitHub só para entender o produto:** comece pelo guia em linguagem simples com fluxo de ecrãs e prints: **[FLUXO_APP_SIMPLES.md](FLUXO_APP_SIMPLES.md)**.

## 1) Visão geral

Aplicativo mobile em React Native (Expo) para a experiência do parque temático **Choco Kingdom**, com:
- autenticação por e-mail/senha e Google;
- mapa interativo com hotspots e status em tempo real;
- área de perfil com edição completa de dados pessoais, contato, senha, endereço e foto;
- backend Node.js/Express conectado ao SQL Server.

---

## 2) Tecnologias utilizadas

## Frontend (mobile)
- `expo` `~55.0.8`
- `react` `19.2.0`
- `react-native` `0.83.2`
- `typescript` `~5.9.2`
- `expo-auth-session` (Google login)
- `expo-blur` (blur em modais)
- `expo-image-picker` e `expo-document-picker` (foto de perfil)
- `expo-file-system` (conversão Base64 para upload)
- `react-native-safe-area-context`
- `@expo/vector-icons`

## Backend (API)
- `node.js`
- `express` `^5.2.1`
- `cors`
- `dotenv`
- `bcryptjs` (hash de senha)
- `google-auth-library` (validação de token Google)
- `mssql` e `msnodesqlv8` (SQL Server, incluindo Windows Auth)

## Banco de dados
- SQL Server
- Banco principal (nome lógico no ambiente atual): `CacauParque` — nome herdado da base; o produto exposto ao utilizador chama-se **Choco Kingdom**.

---

## 3) Arquitetura técnica (alto nível)

- App (`App.tsx`) consome API REST via `fetchWithTimeout`.
- API (`backend/server.js`) valida regras de negócio e persiste no SQL Server.
- Scripts SQL em `sql/` criam e atualizam schema/base de dados.
- Upload de foto de perfil em Base64 com limite aumentado no backend (`express.json({ limit: '25mb' })`).
- Compatibilidade automática de colunas/tabelas legadas via `ensureDbCompat()` e `ensureEnderecosTable()`.

---

## 4) Telas e funcionalidades (rodando atualmente)

## Navegação principal (abas)
- `Home`
- `Ingressos`
- `Mapa`
- `Perfil`

## Home
- carrossel de banners;
- atalhos que levam ao mapa abrindo legenda/categoria específica;
- pull-to-refresh.

## Ingressos
- acesso por aba dedicada na navegação inferior.

## Mapa
- mapa com hotspots clicáveis;
- animação dos ícones (moeda com giro/flutuação suave);
- painel de detalhes do local (nome, fila, status, categoria e imagem);
- legenda com categorias e listas;
- indicação visual de fechado (`X` vermelho) e tempo de fila para atrações abertas;
- pull-to-refresh.

## Perfil
- dashboard de conta e foto de perfil;
- modais com blur para:
  - Informações pessoais;
  - Informações de contato;
  - Senha;
  - Endereço;
  - Excluir conta (confirmação + mensagem final);
- preview ampliado da foto;
- atualização da foto com persistência no banco;
- popup de boas-vindas com apelido;
- pull-to-refresh.

## Fluxos de autenticação
- login por e-mail/senha;
- cadastro com validações (e-mail, senha forte, CPF, data);
- login com Google;
- logout;
- exclusão de conta.

---

## 5) Banco de dados: quantidade, tabelas e colunas

## Quantos bancos de dados?
- `1` banco principal em uso: `CacauParque`.

## Quantas tabelas principais do projeto?
- `5` tabelas de domínio usadas pelo app/API:
  1. `dbo.Clientes`
  2. `dbo.AuthExterno`
  3. `dbo.Enderecos`
  4. `dbo.Parques`
  5. `dbo.MapaLocais`

## Tabela: `dbo.Clientes`
- `Id` (PK, INT IDENTITY)
- `Nome` (NVARCHAR(120), NULL)
- `Sobrenome` (NVARCHAR(120), NULL)
- `Apelido` (NVARCHAR(120), NULL)
- `FotoPerfil` (NVARCHAR(MAX), NULL)
- `Email` (NVARCHAR(180), NOT NULL, único)
- `SenhaHash` (NVARCHAR(255), NOT NULL)
- `DataNascimento` (DATE, NULL)
- `Telefone` (NVARCHAR(20), NULL)
- `Documento` (NVARCHAR(50), NULL)
- `Ativo` (BIT, NOT NULL)
- `CriadoEm` (DATETIME2(0), NOT NULL)
- `AtualizadoEm` (DATETIME2(0), NULL)
- `UltimoLoginEm` (DATETIME2(0), NULL)

## Tabela: `dbo.AuthExterno`
- `Id` (PK, INT IDENTITY)
- `ClienteId` (FK -> `Clientes.Id`)
- `Provider` (NVARCHAR(30), NOT NULL)
- `ProviderUserId` (NVARCHAR(120), NOT NULL)
- `CriadoEm` (DATETIME2(0), NOT NULL)
- Índice único em (`Provider`, `ProviderUserId`)

## Tabela: `dbo.Enderecos`
- `Id` (PK, INT IDENTITY)
- `ClienteId` (FK -> `Clientes.Id`, unique por cliente)
- `Rua` (NVARCHAR(160), NULL)
- `Bairro` (NVARCHAR(120), NULL)
- `Pais` (NVARCHAR(80), NULL)
- `Cep` (NVARCHAR(20), NULL)
- `Numero` (NVARCHAR(20), NULL)
- `CriadoEm` (DATETIME2(0), NOT NULL)
- `AtualizadoEm` (DATETIME2(0), NOT NULL)

## Tabela: `dbo.Parques`
- `Id` (PK, INT IDENTITY)
- `Codigo` (NVARCHAR(50), NOT NULL, único)
- `Nome` (NVARCHAR(120), NOT NULL)
- `Cidade` (NVARCHAR(80), NULL)
- `UF` (NVARCHAR(2), NULL)
- `MapaImagemUrl` (NVARCHAR(500), NULL)
- `MapaLarguraPx` (INT, NULL)
- `MapaAlturaPx` (INT, NULL)
- `Ativo` (BIT, NOT NULL)
- `CriadoEm` (DATETIME2(0), NOT NULL)
- `AtualizadoEm` (DATETIME2(0), NOT NULL)

## Tabela: `dbo.MapaLocais`
- `Id` (PK, INT IDENTITY)
- `ParqueId` (FK -> `Parques.Id`)
- `Codigo` (NVARCHAR(60), NOT NULL)
- `Nome` (NVARCHAR(140), NOT NULL)
- `Tipo` (NVARCHAR(40), NOT NULL)
- `Descricao` (NVARCHAR(1000), NULL)
- `X` (DECIMAL(9,6), NOT NULL)
- `Y` (DECIMAL(9,6), NOT NULL)
- `Largura` (DECIMAL(9,6), NOT NULL)
- `Altura` (DECIMAL(9,6), NOT NULL)
- `Ordem` (INT, NOT NULL)
- `Ativo` (BIT, NOT NULL)
- `CriadoEm` (DATETIME2(0), NOT NULL)
- `AtualizadoEm` (DATETIME2(0), NOT NULL)
- `Classificacao` (NVARCHAR(40), NULL)
- `AlturaMinCm` (INT, NULL)
- `Categoria` (NVARCHAR(20), NULL)
- `Aberto` (BIT, NULL)
- `TempoFilaMin` (INT, NULL)
- `ImagemUrl` (NVARCHAR(800), NULL)
- `IconeMapaUrl` (NVARCHAR(800), NULL)

---

## 6) Endpoints da API (backend atual)

Base padrão: `http://<ip-ou-host>:3000`

## Saúde e mapa
- `GET /api/health`
  - valida conexão da API com SQL Server.

- `GET /api/mapa/locais?parqueCodigo=cacau-parque`
  - retorna hotspots do mapa com dados de status, fila, categoria, imagem e coordenadas.

## Autenticação
- `POST /api/auth/entrar`
  - login por e-mail/senha.

- `POST /api/auth/cadastro`
  - cadastro completo de cliente.

- `POST /api/auth/google`
  - login/cadastro com Google (idToken).

## Cliente/perfil
- `PUT /api/clientes/:id/perfil-pessoal`
  - atualiza nome, sobrenome e apelido.

- `PUT /api/clientes/perfil-pessoal`
  - rota fallback por `id` ou `email` no body.

- `PUT /api/clientes/:id/contato`
  - atualiza e-mail e telefone.

- `PUT /api/clientes/:id/senha`
  - troca senha com validação de senha atual.

- `PUT /api/clientes/senha`
  - rota fallback por `id` ou `email` no body.

- `PUT /api/clientes/:id/foto`
  - atualiza foto de perfil (Base64).

- `DELETE /api/clientes/:id`
  - exclui conta do cliente.

## Endereço
- `GET /api/clientes/:id/endereco`
  - retorna endereço do cliente.

- `PUT /api/clientes/:id/endereco`
  - cria/atualiza endereço (MERGE por `ClienteId`).

## Assets estáticos
- `GET /map-icons/*`
  - serve ícones usados no mapa.

---

## 7) Regras de negócio relevantes

- senha forte obrigatória (mín. 8, maiúscula, minúscula, número e especial);
- e-mail validado no backend;
- CPF validado (11 dígitos válidos) quando informado;
- `Apelido` mínimo 2 caracteres;
- prevenção de conflito de e-mail no cadastro e atualização de contato;
- foto de perfil persiste no banco e substitui a anterior;
- `Enderecos` é 1:1 com cliente (índice único em `ClienteId`);
- exclusão de cliente remove vínculos por FK (`ON DELETE CASCADE` onde aplicável).

---

## 8) Estrutura principal de pastas

- `App.tsx` -> frontend principal (telas, estado, chamadas API, modais).
- `backend/server.js` -> API Express e regras de negócio.
- `sql/auth_schema.sql` -> criação de schema de autenticação/cliente.
- `sql/clientes_colunas_extras.sql` -> migração incremental para tabelas legadas.
- `sql/mapa_locais_schema.sql` -> schema e seed de mapa/parque/hotspots.
- `backend/public/map-icons` -> ícones do mapa servidos estaticamente.

---

## 9) Como subir o projeto (resumo)

## Backend
1. Acesse `choco-app/backend`
2. Instale dependências: `npm install`
3. Inicie: `npm start`

## App mobile
1. Acesse `choco-app`
2. Instale dependências: `npm install`
3. Configure `expo.extra.apiUrl` em `app.json` com IP da máquina
4. Inicie Expo: `npx expo start -c`

---

## 10) Status atual de entrega

Projeto está estruturado com frontend mobile + backend + banco SQL Server, incluindo:
- autenticação (senha e Google),
- mapa interativo com legenda/status/fila/imagens,
- perfil completo com persistência de dados e foto,
- scripts SQL de criação/migração para ambientes novos e legados.

