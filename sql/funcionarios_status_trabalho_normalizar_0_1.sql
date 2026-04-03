/*
  Normaliza dbo.Funcionarios.StatusTrabalho para o contrato atual da API:
    0 = Não (fora / não em serviço)
    1 = Sim (em serviço)

  Legado (script antigo funcionarios_status_trabalho_presenca.sql):
    2 = fora (equivalente a 0 hoje)
    DEFAULT antigo (2) fazia novos cadastros voltarem a gravar 2 até corrigir o DEFAULT.

  Pode rodar no SSMS uma vez; o backend (ensureDbCompat em server.js) aplica o mesmo em runtime.
*/

USE CacauParque;
GO

IF COL_LENGTH('dbo.Funcionarios', 'StatusTrabalho') IS NOT NULL
BEGIN
  UPDATE dbo.Funcionarios SET StatusTrabalho = 0 WHERE StatusTrabalho NOT IN (0, 1);

  DECLARE @dcSt sysname;
  SELECT @dcSt = dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
    AND c.name = N'StatusTrabalho';

  IF @dcSt IS NOT NULL
  BEGIN
    DECLARE @dropDcSt NVARCHAR(400);
    SET @dropDcSt = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@dcSt);
    EXEC sp_executesql @dropDcSt;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.default_constraints dc
    INNER JOIN sys.columns c
      ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
      AND c.name = N'StatusTrabalho'
  )
    ALTER TABLE dbo.Funcionarios
      ADD CONSTRAINT DF_Funcionarios_StatusTrabalho_0 DEFAULT (0) FOR StatusTrabalho;

  IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.Funcionarios')
      AND name = N'CHK_Funcionarios_StatusTrabalho_01'
  )
    ALTER TABLE dbo.Funcionarios
      ADD CONSTRAINT CHK_Funcionarios_StatusTrabalho_01 CHECK (StatusTrabalho IN (0, 1));
END;
GO
