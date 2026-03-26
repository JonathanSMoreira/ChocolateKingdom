-- Schema inicial de autenticacao (leve) para SQL Server
-- Observacao: validar regra de senha forte na API/app:
-- Regras: 1 maiuscula, 1 minuscula, 1 numero, 1 especial, minimo 8 chars.

IF DB_ID('CacauParque') IS NULL
BEGIN
  CREATE DATABASE CacauParque;
END;
GO

USE CacauParque;
GO

IF OBJECT_ID('dbo.AuthExterno', 'U') IS NOT NULL
  DROP TABLE dbo.AuthExterno;
GO

IF OBJECT_ID('dbo.Clientes', 'U') IS NOT NULL
  DROP TABLE dbo.Clientes;
GO

CREATE TABLE dbo.Clientes (
  Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  Nome NVARCHAR(120) NULL,
  Sobrenome NVARCHAR(120) NULL,
  Apelido NVARCHAR(120) NULL,
  FotoPerfil NVARCHAR(MAX) NULL,
  Email NVARCHAR(180) NOT NULL,
  SenhaHash NVARCHAR(255) NOT NULL,
  DataNascimento DATE NULL,
  Telefone NVARCHAR(20) NULL,
  Documento NVARCHAR(50) NULL,
  Ativo BIT NOT NULL CONSTRAINT DF_Clientes_Ativo DEFAULT (1),
  CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Clientes_CriadoEm DEFAULT (SYSDATETIME()),
  AtualizadoEm DATETIME2(0) NULL,
  UltimoLoginEm DATETIME2(0) NULL
);
GO

CREATE UNIQUE INDEX UX_Clientes_Email ON dbo.Clientes (Email);
GO

CREATE TABLE dbo.AuthExterno (
  Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ClienteId INT NOT NULL,
  Provider NVARCHAR(30) NOT NULL,
  ProviderUserId NVARCHAR(120) NOT NULL,
  CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_AuthExterno_CriadoEm DEFAULT (SYSDATETIME()),
  CONSTRAINT FK_AuthExterno_Clientes
    FOREIGN KEY (ClienteId) REFERENCES dbo.Clientes(Id)
    ON DELETE CASCADE
);
GO

CREATE TABLE dbo.Enderecos (
  Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ClienteId INT NOT NULL,
  Rua NVARCHAR(160) NULL,
  Bairro NVARCHAR(120) NULL,
  Pais NVARCHAR(80) NULL,
  Cep NVARCHAR(20) NULL,
  Numero NVARCHAR(20) NULL,
  CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_CriadoEm DEFAULT (SYSDATETIME()),
  AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_AtualizadoEm DEFAULT (SYSDATETIME()),
  CONSTRAINT FK_Enderecos_Clientes
    FOREIGN KEY (ClienteId) REFERENCES dbo.Clientes(Id)
    ON DELETE CASCADE
);
GO

CREATE UNIQUE INDEX UX_Enderecos_ClienteId ON dbo.Enderecos (ClienteId);
GO

CREATE UNIQUE INDEX UX_AuthExterno_Provider_User
  ON dbo.AuthExterno (Provider, ProviderUserId);
GO

-- Exemplo de consulta para login por email:
-- SELECT Id, Nome, Email, SenhaHash, Ativo
-- FROM dbo.Clientes
-- WHERE Email = @Email;

-- Exemplo de atualizacao apos login:
-- UPDATE dbo.Clientes
-- SET UltimoLoginEm = SYSDATETIME(), AtualizadoEm = SYSDATETIME()
-- WHERE Id = @ClienteId;

