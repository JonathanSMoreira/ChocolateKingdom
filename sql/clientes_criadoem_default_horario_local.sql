-- Opcional: troca o DEFAULT de CriadoEm de UTC (SYSUTCDATETIME) para horário do Windows do servidor (SYSDATETIME).
-- Execute no SSMS no banco CacauParque se ainda vir CriadoEm em UTC em linhas criadas só pelo DEFAULT da tabela.

USE CacauParque;
GO

DECLARE @dc SYSNAME;
SELECT @dc = dc.name
FROM sys.default_constraints dc
INNER JOIN sys.columns c
  ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID(N'dbo.Clientes')
  AND c.name = N'CriadoEm';

IF @dc IS NOT NULL
  EXEC(N'ALTER TABLE dbo.Clientes DROP CONSTRAINT ' + QUOTENAME(@dc) + N';');

ALTER TABLE dbo.Clientes
  ADD CONSTRAINT DF_Clientes_CriadoEm DEFAULT (SYSDATETIME()) FOR CriadoEm;
GO
