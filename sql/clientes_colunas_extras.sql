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
