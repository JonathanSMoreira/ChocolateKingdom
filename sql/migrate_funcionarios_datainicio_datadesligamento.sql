/*
  Tabela dbo.Funcionarios:
    - CriadoEm     -> DataInicio (admisso/início do registro)
    - AtualizadoEm -> DataDesligamento (NULL = em atividade; preenchida = fim do vínculo)
  Garante colunas Setor, Cargo, Nivel (não altera Setor/Cargo existentes).
  Ajusta só Nivel = NULL para cargos: estágio(s), auxiliar(es), ajudante(s),
  encarregado de limpeza, líder de higienização (critério por texto do Cargo, CI_AI).
  Recria TR_Clientes_SyncFuncionarios e TR_Funcionarios_NivelPorCargo.

  Execute no banco (ex.: CacauParque) após backups. Idempotente em boa parte;
  sp_rename exige que os nomes antigos ainda existam na primeira execução.
*/
USE CacauParque;
GO

SET NOCOUNT ON;

IF COL_LENGTH('dbo.Funcionarios', 'DataInicio') IS NULL
  AND COL_LENGTH('dbo.Funcionarios', 'CriadoEm') IS NOT NULL
  EXEC sp_rename 'dbo.Funcionarios.CriadoEm', 'DataInicio', 'COLUMN';
GO

IF COL_LENGTH('dbo.Funcionarios', 'DataDesligamento') IS NULL
  AND COL_LENGTH('dbo.Funcionarios', 'AtualizadoEm') IS NOT NULL
  EXEC sp_rename 'dbo.Funcionarios.AtualizadoEm', 'DataDesligamento', 'COLUMN';
GO

IF COL_LENGTH('dbo.Funcionarios', 'DataDesligamento') IS NOT NULL
BEGIN
  ALTER TABLE dbo.Funcionarios ALTER COLUMN DataDesligamento DATETIME2(0) NULL;
  DECLARE @fdc sysname;
  SELECT @fdc = dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
    AND c.name = N'DataDesligamento';
  IF @fdc IS NOT NULL
  BEGIN
    DECLARE @sql_drop_fdc NVARCHAR(400);
    SET @sql_drop_fdc = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@fdc);
    EXEC(@sql_drop_fdc);
  END;
END;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Setor') IS NULL
  ALTER TABLE dbo.Funcionarios ADD Setor NVARCHAR(80) NULL;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Cargo') IS NULL
  ALTER TABLE dbo.Funcionarios ADD Cargo NVARCHAR(80) NULL;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Nivel') IS NULL
  ALTER TABLE dbo.Funcionarios ADD Nivel NVARCHAR(20) NULL;
GO

/* Antigo "AtualizadoEm" não representava desligamento; limpa para quem segue ativo. */
UPDATE dbo.Funcionarios SET DataDesligamento = NULL WHERE Ativos = 1;
GO

/* Para desligados (Ativos = 0), simula data de desligamento aleatória até hoje (janela de 365 dias). */
UPDATE f
SET f.DataDesligamento = DATEADD(DAY, -(ABS(CHECKSUM(NEWID())) % 366), CAST(SYSDATETIME() AS DATE))
FROM dbo.Funcionarios f
WHERE f.Ativos = 0;
GO

UPDATE f
SET f.Nivel = NULL
FROM dbo.Funcionarios f
WHERE f.Nivel IS NOT NULL
  AND f.Cargo IS NOT NULL
  AND (
    f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%estagi%'
    OR (
      f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%auxiliar%'
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI <> N'Auxiliar de Operações'
    )
    OR f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%ajudante%'
    OR (
      f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%encarregad%'
      AND f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%limpeza%'
    )
    OR (
      (
        f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%lider%'
        OR f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%líder%'
      )
      AND f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%higieniz%'
    )
  );
GO

IF OBJECT_ID(N'dbo.TR_Clientes_SyncFuncionarios', N'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_Clientes_SyncFuncionarios;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Nome') IS NOT NULL
  ALTER TABLE dbo.Funcionarios DROP COLUMN Nome;
GO

CREATE TRIGGER dbo.TR_Clientes_SyncFuncionarios
ON dbo.Clientes
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  DELETE f
  FROM dbo.Funcionarios f
  INNER JOIN inserted i ON i.Id = f.FuncionarioId
  WHERE i.Funcionario = 0;

  INSERT INTO dbo.Funcionarios (FuncionarioId, Ativos, DataInicio, DataDesligamento)
  SELECT
    i.Id,
    1,
    SYSDATETIME(),
    NULL
  FROM inserted i
  WHERE i.Funcionario = 1
    AND NOT EXISTS (SELECT 1 FROM dbo.Funcionarios f2 WHERE f2.FuncionarioId = i.Id);
END;
GO

IF OBJECT_ID(N'dbo.TR_Funcionarios_NivelPorCargo', N'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_Funcionarios_NivelPorCargo;
GO

CREATE TRIGGER dbo.TR_Funcionarios_NivelPorCargo
ON dbo.Funcionarios
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE f
  SET f.Nivel = NULL
  FROM dbo.Funcionarios f
  INNER JOIN inserted i ON i.Id = f.Id
  WHERE f.Nivel IS NOT NULL
    AND i.Cargo IS NOT NULL
    AND (
      i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%estagi%'
      OR (
        i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%auxiliar%'
        AND LTRIM(RTRIM(i.Cargo)) COLLATE Latin1_General_CI_AI <> N'Auxiliar de Operações'
      )
      OR i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%ajudante%'
      OR (
        i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%encarregad%'
        AND i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%limpeza%'
      )
      OR (
        (
          i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%lider%'
          OR i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%líder%'
        )
        AND i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%higieniz%'
      )
    );
END;
GO
