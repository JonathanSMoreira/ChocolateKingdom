-- Adiciona colunas usadas pelo app/API do mapa em bases antigas (idempotente).
-- Erro 207 em Categoria / IconeMapaUrl: rode este script no banco CacauParque.

USE CacauParque;
GO

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

  IF COL_LENGTH('dbo.MapaLocais', 'IconeMapaUrl') IS NULL
    ALTER TABLE dbo.MapaLocais ADD IconeMapaUrl NVARCHAR(800) NULL;

  IF COL_LENGTH('dbo.MapaLocais', 'Aberto') IS NOT NULL
  BEGIN
    UPDATE dbo.MapaLocais
    SET Aberto = 0
    WHERE Aberto IS NULL;
  END;
END;
GO
