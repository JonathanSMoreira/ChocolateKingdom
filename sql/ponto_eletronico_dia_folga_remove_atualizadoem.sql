/*
  Migração manual: dbo.PontoEletronicoDia
    - Adiciona Folga (CHAR(1) 'S' ou NULL)
    - Remove AtualizadoEm (substituído pela lógica de atualização no app)

  O backend (ensureDbCompat) aplica o mesmo automaticamente ao subir a API.
*/

USE CacauParque;
GO

IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NOT NULL
BEGIN
  IF COL_LENGTH('dbo.PontoEletronicoDia', 'Folga') IS NULL
    ALTER TABLE dbo.PontoEletronicoDia ADD Folga CHAR(1) NULL
      CONSTRAINT CK_PontoEletronicoDia_Folga_MigSql CHECK (Folga IS NULL OR Folga = N'S');

  IF COL_LENGTH('dbo.PontoEletronicoDia', 'AtualizadoEm') IS NOT NULL
  BEGIN
    DECLARE @dcPe sysname;
    SELECT @dcPe = dc.name
    FROM sys.default_constraints dc
    INNER JOIN sys.columns c
      ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.PontoEletronicoDia')
      AND c.name = N'AtualizadoEm';
    IF @dcPe IS NOT NULL
    BEGIN
      DECLARE @sqlPe NVARCHAR(400) =
        N'ALTER TABLE dbo.PontoEletronicoDia DROP CONSTRAINT ' + QUOTENAME(@dcPe);
      EXEC sp_executesql @sqlPe;
    END;
    ALTER TABLE dbo.PontoEletronicoDia DROP COLUMN AtualizadoEm;
  END;
END;
GO
