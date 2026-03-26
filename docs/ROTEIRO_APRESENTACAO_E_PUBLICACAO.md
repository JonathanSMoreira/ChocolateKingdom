# Roteiro de Apresentação + Subida do Projeto + Branding (Nome/Ícone)

## 1) Roteiro de apresentação (10 a 15 min)

## Abertura (1 min)
- "Este é o Cacau App, um app mobile para experiência de parque com mapa interativo, autenticação e gestão de perfil."
- "A stack é React Native + Expo no app, Node/Express no backend e SQL Server no banco."

## Problema e proposta (1 min)
- Centralizar experiência do visitante em um único app.
- Oferecer visão rápida de atrações, fila, status (aberto/fechado), conta e dados do usuário.

## Demonstração guiada (6 a 8 min)
- **Home**
  - mostrar carrossel;
  - clicar em "Lojas/Atrações" e provar navegação inteligente para o mapa com legenda/categoria aberta.
- **Mapa**
  - mostrar hotspots animados (efeito moeda);
  - abrir detalhes de um local com imagem, status e fila;
  - abrir legenda e mostrar categorias + `X` para fechado + tempo de fila para diversão aberta.
- **Perfil**
  - abrir modais com blur: pessoais, contato, senha, endereço;
  - trocar foto de perfil e confirmar persistência;
  - destacar validações e UX de erro;
  - mostrar fluxo de exclusão com confirmação.
- **Autenticação**
  - login normal e (se configurado) login Google.

## Parte técnica (2 a 3 min)
- Backend com rotas REST para auth, perfil, endereço, mapa.
- SQL Server com tabelas normalizadas: `Clientes`, `AuthExterno`, `Enderecos`, `Parques`, `MapaLocais`.
- Compatibilidade automática de colunas/tabelas legadas na API.
- Upload de foto em Base64 com limite e tratamento de erro.

## Encerramento (1 min)
- "Projeto pronto para evolução de produção: métricas, cache e deploy cloud."
- "Base organizada para escalar novas atrações, novos parques e novas features."

---

## 2) Como subir o projeto (passo a passo)

## Pré-requisitos
- Node.js instalado.
- SQL Server rodando.
- Dependências do Expo/Android Studio (para emulador) ou Expo Go no celular.

## Banco de dados
1. No SQL Server, crie/configure o banco `CacauParque`.
2. Execute os scripts:
   - `sql/auth_schema.sql` (base nova), ou
   - `sql/clientes_colunas_extras.sql` (base já existente),
   - `sql/mapa_locais_schema.sql` (estrutura e seed do mapa).

## Backend
1. Abra terminal em `choco-app/backend`.
2. Instale pacotes:
   - `npm install`
3. Configure `.env` (DB e Google, se usar).
4. Suba API:
   - `npm start`
5. Validar saúde:
   - `GET http://SEU_IP:3000/api/health`

## App mobile
1. Abra terminal em `choco-app`.
2. Instale pacotes:
   - `npm install`
3. Ajuste API no `app.json`:
   - `expo.extra.apiUrl` -> `http://SEU_IP_LOCAL:3000`
4. Inicie Expo limpando cache:
   - `npx expo start -c`
5. Teste no celular (mesma rede Wi-Fi) via Expo Go.

---

## 3) Ajustar nome do app e ícone (celular + Play Store)

## Nome exibido no celular
No `app.json`, alterar:
- `expo.name` -> nome que aparece no app launcher e lojas.
- `expo.slug` -> identificador do projeto Expo (URL-friendly).

Exemplo:
```json
{
  "expo": {
    "name": "Cacau Parque",
    "slug": "cacau-parque"
  }
}
```

## Pacote Android (Play Store)
- Campo: `expo.android.package`
- Exemplo: `com.cacaushow.parqueapp`
- Importante: em app publicado, trocar package cria app novo na Play Store.

## Ícone principal do app
- Arquivo atual: `assets/icon.png`
- Recomendação: PNG quadrado 1024x1024, sem transparência excessiva.
- Campo: `expo.icon`

## Ícone adaptativo Android
Arquivos usados:
- `assets/android-icon-foreground.png`
- `assets/android-icon-background.png`
- `assets/android-icon-monochrome.png`

Configuração:
- `expo.android.adaptiveIcon.foregroundImage`
- `expo.android.adaptiveIcon.backgroundImage`
- `expo.android.adaptiveIcon.monochromeImage`

## Splash
- Arquivo: `assets/splash-icon.png`
- Campos em `expo.splash`.

## Favicon web (opcional)
- Arquivo: `assets/favicon.png`
- Campo: `expo.web.favicon`.

---

## 4) Checklist para publicação (Play Store)

- Nome final aprovado.
- Ícone 1024x1024 final aprovado.
- Package Android final definido.
- Teste em aparelho físico (login, mapa, perfil, foto, exclusão).
- Build release gerada.
- Screenshots, descrição e classificação na Play Console.

---

## 5) Build de produção (resumo)

No projeto `choco-app`:
- instalar/usar EAS:
  - `npx eas login`
  - `npx eas build:configure`
  - `npx eas build -p android`

Resultado: `.aab` para subir na Play Store.

---

## 6) Próximo passo recomendado

Definir agora:
1. Nome final do app.
2. Package final Android.
3. Arquivos finais de ícone/splash.

Com isso, o ajuste no `app.json` e assets fica definitivo para publicação.

