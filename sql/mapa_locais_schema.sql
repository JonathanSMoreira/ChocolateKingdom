-- Estrutura para hotspots de mapa (parques, atracoes, restaurantes etc.)
-- Banco alvo: CacauParque

IF DB_ID('CacauParque') IS NULL
BEGIN
  CREATE DATABASE CacauParque;
END;
GO

USE CacauParque;
GO

-- Parque (suporta multi-parque no futuro).
IF OBJECT_ID('dbo.Parques', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Parques (
    Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Parques PRIMARY KEY,
    Codigo NVARCHAR(50) NOT NULL,
    Nome NVARCHAR(120) NOT NULL,
    Cidade NVARCHAR(80) NULL,
    UF NVARCHAR(2) NULL,
    MapaImagemUrl NVARCHAR(500) NULL,
    MapaLarguraPx INT NULL,
    MapaAlturaPx INT NULL,
    Ativo BIT NOT NULL CONSTRAINT DF_Parques_Ativo DEFAULT (1),
    CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Parques_CriadoEm DEFAULT (SYSDATETIME()),
    AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Parques_AtualizadoEm DEFAULT (SYSDATETIME())
  );
END;
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'UX_Parques_Codigo'
    AND object_id = OBJECT_ID('dbo.Parques')
)
BEGIN
  CREATE UNIQUE INDEX UX_Parques_Codigo ON dbo.Parques(Codigo);
END;
GO

-- Ponto clicavel no mapa (hotspot).
-- Coordenadas normalizadas em percentual 0..1 para facilitar resize no app.
IF OBJECT_ID('dbo.MapaLocais', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.MapaLocais (
    Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MapaLocais PRIMARY KEY,
    ParqueId INT NOT NULL,
    Codigo NVARCHAR(60) NOT NULL,
    Nome NVARCHAR(140) NOT NULL,
    Tipo NVARCHAR(40) NOT NULL, -- exemplo: atracao, restaurante, loja, banheiro, servico
    Descricao NVARCHAR(1000) NULL,

    -- Retangulo clicavel (x,y,w,h) em escala 0..1.
    X DECIMAL(9,6) NOT NULL,
    Y DECIMAL(9,6) NOT NULL,
    Largura DECIMAL(9,6) NOT NULL,
    Altura DECIMAL(9,6) NOT NULL,

    Ordem INT NOT NULL CONSTRAINT DF_MapaLocais_Ordem DEFAULT (0),
    Ativo BIT NOT NULL CONSTRAINT DF_MapaLocais_Ativo DEFAULT (1),
    CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_MapaLocais_CriadoEm DEFAULT (SYSDATETIME()),
    AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_MapaLocais_AtualizadoEm DEFAULT (SYSDATETIME()),

    CONSTRAINT FK_MapaLocais_Parques
      FOREIGN KEY (ParqueId) REFERENCES dbo.Parques(Id),

    CONSTRAINT CHK_MapaLocais_X CHECK (X >= 0 AND X <= 1),
    CONSTRAINT CHK_MapaLocais_Y CHECK (Y >= 0 AND Y <= 1),
    CONSTRAINT CHK_MapaLocais_Largura CHECK (Largura > 0 AND Largura <= 1),
    CONSTRAINT CHK_MapaLocais_Altura CHECK (Altura > 0 AND Altura <= 1),
    CONSTRAINT CHK_MapaLocais_Tipo CHECK (LEN(Tipo) >= 3)
  );
END;
GO

-- Migração para adicionar campos específicos de atrações (idempotente).
IF OBJECT_ID('dbo.MapaLocais', 'U') IS NOT NULL
BEGIN
  IF COL_LENGTH('dbo.MapaLocais', 'Classificacao') IS NULL
    ALTER TABLE dbo.MapaLocais ADD Classificacao NVARCHAR(40) NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'AlturaMinCm') IS NULL
    ALTER TABLE dbo.MapaLocais ADD AlturaMinCm INT NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'Categoria') IS NULL
    ALTER TABLE dbo.MapaLocais ADD Categoria NVARCHAR(20) NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'Aberto') IS NULL
    ALTER TABLE dbo.MapaLocais ADD Aberto BIT NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'TempoFilaMin') IS NULL
    ALTER TABLE dbo.MapaLocais ADD TempoFilaMin INT NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'ImagemUrl') IS NULL
    ALTER TABLE dbo.MapaLocais ADD ImagemUrl NVARCHAR(800) NULL;

  -- Ícone clicável no mapa (URL absoluta ou caminho relativo servido pelo backend, ex.: /map-icons/icon-banho.png).
  IF COL_LENGTH('dbo.MapaLocais', 'IconeMapaUrl') IS NULL
    ALTER TABLE dbo.MapaLocais ADD IconeMapaUrl NVARCHAR(800) NULL;
END;
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'UX_MapaLocais_Parque_Codigo'
    AND object_id = OBJECT_ID('dbo.MapaLocais')
)
BEGIN
  CREATE UNIQUE INDEX UX_MapaLocais_Parque_Codigo
    ON dbo.MapaLocais(ParqueId, Codigo);
END;
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_MapaLocais_Parque_Ativo_Ordem'
    AND object_id = OBJECT_ID('dbo.MapaLocais')
)
BEGIN
  CREATE INDEX IX_MapaLocais_Parque_Ativo_Ordem
    ON dbo.MapaLocais(ParqueId, Ativo, Ordem, Nome);
END;
GO

-- Seed inicial do parque atual (idempotente).
IF NOT EXISTS (SELECT 1 FROM dbo.Parques WHERE Codigo = 'cacau-parque')
BEGIN
  INSERT INTO dbo.Parques (Codigo, Nome, Cidade, UF, MapaImagemUrl, MapaLarguraPx, MapaAlturaPx)
  VALUES ('cacau-parque', 'Cacau Parque', NULL, NULL, NULL, 1024, 1024);
END;
GO

-- Mantém referência da malha do mapa (arte isométrica nova, sem bolinhas na imagem).
UPDATE dbo.Parques
SET MapaLarguraPx = 1024, MapaAlturaPx = 1024
WHERE Codigo = 'cacau-parque';
GO

/*
  Malha do mapa na arte: 1024 x 1024 px, origem (0,0) no CANTO INFERIOR ESQUERDO,
  X para a direita, Y para CIMA.

  No app/SQL, X, Y, Largura e Altura são o retângulo clicável com origem no CANTO
  SUPERIOR ESQUERDO da imagem, valores normalizados 0..1 (Y cresce para baixo).

  A partir do CENTRO (xc, yc) na malha inferior-esquerda (0..1024):
    xNormCentro = xc / 1024
    yNormCentro = 1 - (yc / 1024)
    X = xNormCentro - Largura/2
    Y = yNormCentro - Altura/2
*/

-- Seed de locais/hotspots (idempotente).
DECLARE @ParqueId INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueId IS NOT NULL
BEGIN
  -- Banheiro — centro arte ~(920,410) malha inferior-esquerda
  IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'banheiro-topo')
  BEGIN
    INSERT INTO dbo.MapaLocais
      (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
    VALUES
      (@ParqueId, 'banheiro-topo', 'Banheiro', 'banheiro', 'Higiene e fraldário.', 0.863438, 0.572109, 0.070000, 0.055000, 10, NULL, NULL, N'Banheiro', 0, NULL,
       'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80',
       '/map-icons/icon-banho.png');
  END;

  -- Restaurante — edifício azul ~(830,600)
  IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'restaurante-direita')
  BEGIN
    INSERT INTO dbo.MapaLocais
      (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
    VALUES
      (@ParqueId, 'restaurante-direita', 'Restaurante', 'restaurante', 'Pratos e sobremesas.', 0.408750, 0.710859, 0.090000, 0.070000, 20, NULL, NULL, N'Comida', 0, NULL,
       'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80',
       '/map-icons/icon-comida.png');
  END;

  -- Lanchonete — prédio Cacao Show direita ~(680,280)
  IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'lanchonete-meio')
  BEGIN
    INSERT INTO dbo.MapaLocais
      (ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem, Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl)
    VALUES
      (@ParqueId, 'lanchonete-meio', 'Lanchonete', 'lanchonete', 'Lanches rápidos e bebidas.', 0.619063, 0.691563, 0.090000, 0.070000, 30, NULL, NULL, N'Comida', 0, NULL,
       'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80',
       '/map-icons/icon-comida.png');
  END;

  -- Montanha — pico amarelo ~(350,850)
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

  -- PKaleo — roda-gigante arco-íris esquerda ~(210,550)
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

  -- Cacau Show — prédio Cacao Show esquerda ~(480,250)
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
END;
GO

-- Sincroniza caixas clicáveis com a nova arte (execute sempre que ajustar-malha no mapa).
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

-- Garante ícone de mapa em bases já existentes (idempotente: sobrescreve com o padrão do exemplo).
DECLARE @ParqueId2 INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueId2 IS NOT NULL AND COL_LENGTH('dbo.MapaLocais', 'IconeMapaUrl') IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET IconeMapaUrl = '/map-icons/icon-banho.png'
  WHERE ParqueId = @ParqueId2 AND Codigo = 'banheiro-topo'
    AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');

  UPDATE dbo.MapaLocais
  SET IconeMapaUrl = '/map-icons/icon-comida.png'
  WHERE ParqueId = @ParqueId2 AND Codigo IN ('restaurante-direita', 'lanchonete-meio')
    AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');

  UPDATE dbo.MapaLocais
  SET IconeMapaUrl = '/map-icons/icon-diversao.png'
  WHERE ParqueId = @ParqueId2 AND Codigo IN ('montanha-russa-encantada', 'pkaleo', 'cacau-show')
    AND (IconeMapaUrl IS NULL OR LTRIM(RTRIM(IconeMapaUrl)) = '');
END;
GO

-- Garante imagens dos locais no card de detalhe (idempotente: preenche se vazio).
DECLARE @ParqueIdImg INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueIdImg IS NOT NULL AND COL_LENGTH('dbo.MapaLocais', 'ImagemUrl') IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = @ParqueIdImg
    AND Codigo = 'banheiro-topo'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = @ParqueIdImg
    AND Codigo = 'restaurante-direita'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80'
  WHERE ParqueId = @ParqueIdImg
    AND Codigo = 'lanchonete-meio'
    AND (ImagemUrl IS NULL OR LTRIM(RTRIM(ImagemUrl)) = '');

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://upload.wikimedia.org/wikipedia/commons/3/3d/Kingda_Ka.jpg'
  WHERE ParqueId = @ParqueIdImg
    AND Codigo = 'montanha-russa-encantada';

  UPDATE dbo.MapaLocais
  SET ImagemUrl = 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chocolate_%28blue_background%29.jpg'
  WHERE ParqueId = @ParqueIdImg
    AND Codigo = 'cacau-show';
END;
GO

-- Atualiza Categoria para registros antigos/anteriores (idempotente).
DECLARE @ParqueId INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

UPDATE dbo.MapaLocais
SET Categoria = N'Banheiro'
WHERE ParqueId = @ParqueId
  AND Codigo = 'banheiro-topo'
  AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

UPDATE dbo.MapaLocais
SET Categoria = N'Comida'
WHERE ParqueId = @ParqueId
  AND Codigo IN ('restaurante-direita', 'lanchonete-meio')
  AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

UPDATE dbo.MapaLocais
SET Categoria = N'Diversão'
WHERE ParqueId = @ParqueId
  AND Codigo IN ('montanha-russa-encantada', 'pkaleo', 'cacau-show')
  AND (Categoria IS NULL OR LTRIM(RTRIM(Categoria)) = N'');

-- Normaliza categorias antigas em minúsculas (idempotente).
UPDATE dbo.MapaLocais SET Categoria = N'Banheiro' WHERE Categoria COLLATE Latin1_General_CI_AI = N'banheiro';
UPDATE dbo.MapaLocais SET Categoria = N'Comida' WHERE Categoria COLLATE Latin1_General_CI_AI = N'comida';
UPDATE dbo.MapaLocais SET Categoria = N'Diversão' WHERE Categoria COLLATE Latin1_General_CI_AI = N'diversao';

GO

/*
  Altura mínima exibida no app:
  - Classificação com Adulto → pelo menos 140 cm.
  - Só crianças (Infantil / Criança, sem Adulto) → pelo menos 110 cm.
*/
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

-- Padroniza status de funcionamento: NULL -> 0 (fechado).
DECLARE @ParqueAberto INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF @ParqueAberto IS NOT NULL
BEGIN
  UPDATE dbo.MapaLocais
  SET Aberto = 0
  WHERE ParqueId = @ParqueAberto
    AND Aberto IS NULL;
END;
GO

/*
  TempoFilaMin: múltiplos de 5 (5–60 min), aleatório por execução nas atrações abertas.
  Atrações fechadas: sem tempo de fila.
*/
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

-- Exemplo para validar rapidamente (descomente para inserir 1 hotspot de teste):
/*
DECLARE @ParqueId INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = 'cacau-parque');

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'rest-central')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, Classificacao, AlturaMinCm, X, Y, Largura, Altura, Ordem)
  VALUES
    (@ParqueId, 'rest-central', 'Restaurante Central', 'restaurante',
     'Pratos executivos e sobremesas.', NULL, NULL,
     0.45, 0.27, 0.06, 0.06, 10);
END;

IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = 'montanha-russa-encantada')
BEGIN
  INSERT INTO dbo.MapaLocais
    (ParqueId, Codigo, Nome, Tipo, Descricao, Classificacao, AlturaMinCm, X, Y, Largura, Altura, Ordem)
  VALUES
    (@ParqueId, 'montanha-russa-encantada', 'Montanha Russa encantada', 'atracao',
     'Brinquedo emocionante com percurso encantado.', 'Infantil, Adulto', 140,
     0.34, 0.72, 0.14, 0.10, 20);
END;
*/

