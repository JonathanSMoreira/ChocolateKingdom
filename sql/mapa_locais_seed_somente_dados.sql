/*
  Preenche dbo.Parques e dbo.MapaLocais quando as tabelas existem mas estão vazias.
  Execute no SSMS no banco CacauParque (F5).

  Antes: se aparecer erro "nome de objeto inválido", rode o início de mapa_locais_schema.sql
  até criar Parques e MapaLocais. Se faltar coluna, rode mapa_locais_add_colunas_mapa.sql.
*/

USE CacauParque;
GO

IF OBJECT_ID('dbo.Parques', 'U') IS NULL OR OBJECT_ID('dbo.MapaLocais', 'U') IS NULL
BEGIN
  RAISERROR('Crie primeiro as tabelas dbo.Parques e dbo.MapaLocais (mapa_locais_schema.sql).', 16, 1);
  RETURN;
END;
GO

-- 1) Parque padrão
IF NOT EXISTS (SELECT 1 FROM dbo.Parques WHERE Codigo = 'cacau-parque')
BEGIN
  INSERT INTO dbo.Parques (Codigo, Nome, Cidade, UF, MapaImagemUrl, MapaLarguraPx, MapaAlturaPx)
  VALUES ('cacau-parque', 'Cacau Parque', NULL, NULL, NULL, 1024, 1024);
END;

UPDATE dbo.Parques
SET MapaLarguraPx = 1024, MapaAlturaPx = 1024
WHERE Codigo = 'cacau-parque';
GO

-- 2) Hotspots (só inserem se ainda não existirem por Codigo)
DECLARE @ParqueId INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueId IS NULL
BEGIN
  RAISERROR('Não foi encontrado Parques.Codigo = cacau-parque.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'banheiro-topo')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'banheiro-topo', 'Banheiro', 'banheiro', 'Higiene e fraldário.', 0.863438, 0.572109, 0.070000, 0.055000, 10, NULL, NULL, N'Banheiro', 0, NULL,
     'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80',
     '/map-icons/icon-banho.png');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'restaurante-direita')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'restaurante-direita', 'Restaurante', 'restaurante', 'Pratos e sobremesas.', 0.408750, 0.710859, 0.090000, 0.070000, 20, NULL, NULL, N'Comida', 0, NULL,
     'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80',
     '/map-icons/icon-comida.png');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'lanchonete-meio')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'lanchonete-meio', 'Lanchonete', 'lanchonete', 'Lanches rápidos e bebidas.', 0.619063, 0.691563, 0.090000, 0.070000, 30, NULL, NULL, N'Comida', 0, NULL,
     'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80',
     '/map-icons/icon-comida.png');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'montanha-russa-encantada')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'montanha-russa-encantada', 'Montanha Russa encantada', 'atracao',
     'Brinquedo emocionante com percurso encantado.',
     0.286797, 0.124922, 0.110000, 0.090000,
     40,
    'Infantil, Adulto', 140,
    N'Diversão',
    1, 25,
     'https://images.unsplash.com/photo-1526481280695-3c687fd643ed?auto=format&fit=crop&w=800&q=80',
     '/map-icons/icon-diversao.png');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'pkaleo')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'pkaleo', 'PKaleo', 'atracao',
     'Brinquedo emocionante!',
     0.155078, 0.420391, 0.100000, 0.085000,
     50,
    'Infantil', 110,
    N'Diversão',
    1, 15,
     'https://images.unsplash.com/photo-1520975661595-6453be3f7070?auto=format&fit=crop&w=800&q=80',
     '/map-icons/icon-diversao.png');
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'cacau-show')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
  VALUES
    (@ParqueId, 'cacau-show', 'Cacau Show', 'atracao',
     'Show e experiências.',
     0.765547, 0.379063, 0.120000, 0.090000,
     60,
    'Adulto', 140,
    N'Diversão',
    0, NULL,
     'https://images.unsplash.com/photo-1519750157634-b6b7a7e2f1b1?auto=format&fit=crop&w=800&q=80',
     '/map-icons/icon-diversao.png');
END;
GO

-- 3) Alinha caixas e categorias/URLs (idempotente)
DECLARE @ParqueIdMap INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueIdMap IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais SET X = 0.863438, Y = 0.572109, Largura = 0.070000, Altura = 0.055000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'banheiro-topo';

  UPDATE dbo.MapaLocais SET X = 0.408750, Y = 0.710859, Largura = 0.090000, Altura = 0.070000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'restaurante-direita';

  UPDATE dbo.MapaLocais SET X = 0.619063, Y = 0.691563, Largura = 0.090000, Altura = 0.070000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'lanchonete-meio';

  UPDATE dbo.MapaLocais SET X = 0.286797, Y = 0.124922, Largura = 0.110000, Altura = 0.090000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'montanha-russa-encantada';

  UPDATE dbo.MapaLocais SET X = 0.155078, Y = 0.420391, Largura = 0.100000, Altura = 0.085000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'pkaleo';

  UPDATE dbo.MapaLocais SET X = 0.765547, Y = 0.379063, Largura = 0.120000, Altura = 0.090000
  WHERE ParqueId = @ParqueIdMap AND Codigo = 'cacau-show';
END;
GO

DECLARE @Pid INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

UPDATE dbo.MapaLocais SET Categoria = N'Banheiro'
WHERE ParqueId = @Pid AND Codigo = 'banheiro-topo' AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

UPDATE dbo.MapaLocais SET Categoria = N'Comida'
WHERE ParqueId = @Pid AND Codigo IN ('restaurante-direita', 'lanchonete-meio') AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

UPDATE dbo.MapaLocais SET Categoria = N'Diversão'
WHERE ParqueId = @Pid AND Codigo IN ('montanha-russa-encantada', 'pkaleo', 'cacau-show') AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

UPDATE dbo.MapaLocais SET Categoria = N'Banheiro' WHERE Categoria COLLATE Latin1_General_CI_AI = N'banheiro';
UPDATE dbo.MapaLocais SET Categoria = N'Comida' WHERE Categoria COLLATE Latin1_General_CI_AI = N'comida';
UPDATE dbo.MapaLocais SET Categoria = N'Diversão' WHERE Categoria COLLATE Latin1_General_CI_AI = N'diversao';
GO

IF COL_LENGTH('dbo.MapaLocais', 'IconeMapaUrl') IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais SET IconeMapaUrl = '/map-icons/icon-banho.png'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'banheiro-topo' AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');

  UPDATE dbo.MapaLocais SET IconeMapaUrl = '/map-icons/icon-comida.png'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo IN ('restaurante-direita', 'lanchonete-meio') AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');

  UPDATE dbo.MapaLocais SET IconeMapaUrl = '/map-icons/icon-diversao.png'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo IN ('montanha-russa-encantada', 'pkaleo', 'cacau-show') AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');
END;
GO

IF COL_LENGTH('dbo.MapaLocais', 'ImagemUrl') IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'banheiro-topo'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'restaurante-direita'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'lanchonete-meio'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://upload.wikimedia.org/wikipedia/commons/3/3d/Kingda_Ka.jpg'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'montanha-russa-encantada';

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chocolate_%28blue_background%29.jpg'
  WHERE ParqueId = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque')
    AND Codigo = 'cacau-show';
END;
GO

DECLARE @ParqueAlt INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueAlt IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET AlturaMinCm = 110
  WHERE ParqueId = @ParqueAlt
    AND Classificacao IS NOT NULL
    AND (
      UPPER(Classificacao) LIKE N'%INFANTIL%'
      OR UPPER(Classificacao) LIKE N'%CRIAN%'
    )
    AND UPPER(Classificacao) NOT LIKE N'%ADULTO%'
    AND (AlturaMinCm IS NULL OR AlturaMinCm < 110);

  UPDATE dbo.MapaLocais
  SET AlturaMinCm = 140
  WHERE ParqueId = @ParqueAlt
    AND Classificacao IS NOT NULL
    AND UPPER(Classificacao) LIKE N'%ADULTO%'
    AND (AlturaMinCm IS NULL OR AlturaMinCm < 140);
END;
GO

DECLARE @ParqueAberto INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueAberto IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET Aberto = 0
  WHERE ParqueId = @ParqueAberto
    AND Aberto IS NULL;
END;
GO

DECLARE @ParqueFila INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueFila IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET TempoFilaMin = NULL
  WHERE ParqueId = @ParqueFila
    AND Categoria COLLATE Latin1_General_CI_AI = N'diversao'
    AND (Aberto = 0 OR Aberto IS NULL);

  UPDATE m
  SET TempoFilaMin = 5 * (1 + (ABS(CHECKSUM(NEWID())) % 12))
  FROM dbo.MapaLocais m
  WHERE m.ParqueId = @ParqueFila
    AND m.Categoria COLLATE Latin1_General_CI_AI = N'diversao'
    AND m.Aberto = 1;
END;
GO

-- Conferência
SELECT COUNT(*) AS QtdParques FROM dbo.Parques;
SELECT COUNT(*) AS QtdMapaLocais FROM dbo.MapaLocais;
SELECT Id, Codigo, Nome FROM dbo.Parques;
SELECT Codigo, Nome, Categoria, Classificacao, AlturaMinCm, Aberto, TempoFilaMin
FROM dbo.MapaLocais
ORDER BY Ordem, Nome;
GO
