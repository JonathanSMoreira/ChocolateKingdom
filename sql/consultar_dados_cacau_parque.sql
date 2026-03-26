-- Ver todos os registros do que o app usa hoje (tudo no banco CacauParque).
-- SSMS: abrir este ficheiro e Executar (F5). Cada bloco abaixo devolve uma grelha separada.

USE CacauParque;
GO

/* ---------- Parques (cadastro do parque / malha do mapa) ---------- */
IF OBJECT_ID('dbo.Parques', 'U') IS NOT NULL
  SELECT Id, Codigo, Nome, Cidade, UF, MapaImagemUrl, MapaLarguraPx, MapaAlturaPx, Ativo, CriadoEm, AtualizadoEm
  FROM dbo.Parques
  ORDER BY Id;
ELSE
  SELECT '(tabela dbo.Parques não existe)' AS Aviso;
GO

/* ---------- Locais / hotspots do mapa ---------- */
IF OBJECT_ID('dbo.MapaLocais', 'U') IS NOT NULL AND OBJECT_ID('dbo.Parques', 'U') IS NOT NULL
  SELECT m.Id, p.Codigo AS ParqueCodigo,
         m.Codigo, m.Nome, m.Tipo, m.Categoria,
         m.X, m.Y, m.Largura, m.Altura,
         m.Classificacao, m.AlturaMinCm, m.Aberto, m.TempoFilaMin,
         m.ImagemUrl, m.IconeMapaUrl,
         m.Ordem, m.Ativo, m.CriadoEm, m.AtualizadoEm
  FROM dbo.MapaLocais m
  INNER JOIN dbo.Parques p ON p.Id = m.ParqueId
  ORDER BY m.Ordem, m.Nome;
ELSE
  SELECT '(tabelas MapaLocais/Parques indisponíveis)' AS Aviso;
GO

/* ---------- Clientes (login / cadastro) — sem expor o hash ---------- */
IF OBJECT_ID('dbo.Clientes', 'U') IS NOT NULL
  SELECT Id, Nome, Email,
         CASE WHEN SenhaHash IS NULL OR LEN(SenhaHash) = 0 THEN '(vazio)' ELSE '(definida)' END AS Senha,
         DataNascimento, Telefone, Documento,
         Ativo, CriadoEm, AtualizadoEm, UltimoLoginEm
  FROM dbo.Clientes
  ORDER BY Id;
ELSE
  SELECT '(tabela dbo.Clientes não existe — execute auth_schema.sql)' AS Aviso;
GO

/* ---------- Ligações Google (ou outros providers) ---------- */
IF OBJECT_ID('dbo.AuthExterno', 'U') IS NOT NULL AND OBJECT_ID('dbo.Clientes', 'U') IS NOT NULL
  SELECT a.Id, a.ClienteId, c.Email AS ClienteEmail, c.Nome AS ClienteNome,
         a.Provider, a.ProviderUserId, a.CriadoEm
  FROM dbo.AuthExterno a
  INNER JOIN dbo.Clientes c ON c.Id = a.ClienteId
  ORDER BY a.Id;
ELSE
  SELECT '(tabela AuthExterno ou Clientes não existe)' AS Aviso;
GO
