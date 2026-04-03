-- Execute no banco CacauParque se a tabela Clientes já existir sem estas colunas.
-- Rode tudo no SSMS (F5). Depois reinicie o backend (npm start).

USE CacauParque;
GO

IF COL_LENGTH('dbo.Clientes', 'AtualizadoEm') IS NULL
  ALTER TABLE dbo.Clientes ADD AtualizadoEm DATETIME2(0) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'UltimoLoginEm') IS NULL
  ALTER TABLE dbo.Clientes ADD UltimoLoginEm DATETIME2(0) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'CriadoEm') IS NULL
  ALTER TABLE dbo.Clientes ADD CriadoEm DATETIME2(0) NOT NULL
    CONSTRAINT DF_Clientes_CriadoEm_Mig DEFAULT (SYSDATETIME());
GO

IF COL_LENGTH('dbo.Clientes', 'Ativo') IS NULL
  ALTER TABLE dbo.Clientes ADD Ativo BIT NOT NULL CONSTRAINT DF_Clientes_Ativo_Mig DEFAULT (1);
GO

IF COL_LENGTH('dbo.Clientes', 'DataNascimento') IS NULL
  ALTER TABLE dbo.Clientes ADD DataNascimento DATE NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'Telefone') IS NULL
  ALTER TABLE dbo.Clientes ADD Telefone NVARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'Documento') IS NULL
  ALTER TABLE dbo.Clientes ADD Documento NVARCHAR(50) NULL;
GO

-- Se Documento já existia como NVARCHAR(14), alarga para caber CPF formatado / outros docs.
IF COL_LENGTH('dbo.Clientes', 'Documento') IS NOT NULL
  ALTER TABLE dbo.Clientes ALTER COLUMN Documento NVARCHAR(50) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'Sobrenome') IS NULL
  ALTER TABLE dbo.Clientes ADD Sobrenome NVARCHAR(120) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'Apelido') IS NULL
  ALTER TABLE dbo.Clientes ADD Apelido NVARCHAR(120) NULL;
GO

IF COL_LENGTH('dbo.Clientes', 'FotoPerfil') IS NULL
  ALTER TABLE dbo.Clientes ADD FotoPerfil NVARCHAR(MAX) NULL;
GO

-- Migração suave: se já havia Nome preenchido e Apelido vazio, reaproveita o Nome como Apelido.
UPDATE dbo.Clientes
SET Apelido = Nome
WHERE (Apelido IS NULL OR LTRIM(RTRIM(Apelido)) = '')
  AND Nome IS NOT NULL
  AND LTRIM(RTRIM(Nome)) <> '';
GO

IF OBJECT_ID('dbo.Enderecos', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Enderecos (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    ClienteId INT NOT NULL,
    Rua NVARCHAR(160) NULL,
    Bairro NVARCHAR(120) NULL,
    Pais NVARCHAR(80) NULL,
    Cep NVARCHAR(20) NULL,
    Numero NVARCHAR(20) NULL,
    CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_CriadoEm_Mig DEFAULT (SYSDATETIME()),
    AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_AtualizadoEm_Mig DEFAULT (SYSDATETIME()),
    CONSTRAINT FK_Enderecos_Clientes_Mig
      FOREIGN KEY (ClienteId) REFERENCES dbo.Clientes(Id)
      ON DELETE CASCADE
  );
END;
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'UX_Enderecos_ClienteId'
    AND object_id = OBJECT_ID('dbo.Enderecos')
)
BEGIN
  CREATE UNIQUE INDEX UX_Enderecos_ClienteId ON dbo.Enderecos (ClienteId);
END;
GO

IF COL_LENGTH('dbo.Clientes', 'Funcionario') IS NULL
  ALTER TABLE dbo.Clientes ADD Funcionario BIT NOT NULL
    CONSTRAINT DF_Clientes_Funcionario_Mig DEFAULT (0);
GO

IF OBJECT_ID('dbo.Funcionarios', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Funcionarios (
    Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Funcionarios_Mig PRIMARY KEY,
    FuncionarioId INT NOT NULL,
    Ativos BIT NOT NULL CONSTRAINT DF_Funcionarios_Ativos_Mig DEFAULT (1),
    Setor NVARCHAR(80) NULL,
    Cargo NVARCHAR(80) NULL,
    Nivel NVARCHAR(20) NULL,
    DataInicio DATETIME2(0) NOT NULL CONSTRAINT DF_Funcionarios_DataInicio_Mig DEFAULT (SYSDATETIME()),
    DataDesligamento DATETIME2(0) NULL,
    CONSTRAINT FK_Funcionarios_Clientes_Mig
      FOREIGN KEY (FuncionarioId) REFERENCES dbo.Clientes(Id) ON DELETE CASCADE,
    CONSTRAINT UX_Funcionarios_FuncionarioId_Mig UNIQUE (FuncionarioId)
  );
END;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Ativos') IS NULL
  ALTER TABLE dbo.Funcionarios ADD Ativos BIT NOT NULL
    CONSTRAINT DF_Funcionarios_Ativos_Mig_Compat DEFAULT (1);
GO

IF COL_LENGTH('dbo.Funcionarios', 'FuncionarioId') IS NULL
  AND COL_LENGTH('dbo.Funcionarios', 'ClienteId') IS NOT NULL
  EXEC sp_rename 'dbo.Funcionarios.ClienteId', 'FuncionarioId', 'COLUMN';
GO

/* Bases antigas: renomear datas e acrescentar Setor/Cargo/Nivel */
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
  DECLARE @fdc_mig sysname;
  SELECT @fdc_mig = dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
    AND c.name = N'DataDesligamento';
  IF @fdc_mig IS NOT NULL
  BEGIN
    DECLARE @sql_drop_fdc_mig NVARCHAR(400);
    SET @sql_drop_fdc_mig = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@fdc_mig);
    EXEC(@sql_drop_fdc_mig);
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

/* Remove coluna Nome (dados vivem em Clientes); exige dropar trigger que a referencie. */
IF OBJECT_ID(N'dbo.TR_Clientes_SyncFuncionarios', N'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_Clientes_SyncFuncionarios;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Nome') IS NOT NULL
  ALTER TABLE dbo.Funcionarios DROP COLUMN Nome;
GO

/* Recrie os triggers com migrate_funcionarios_datainicio_datadesligamento.sql ou suba o backend (ensureDbCompat). */

