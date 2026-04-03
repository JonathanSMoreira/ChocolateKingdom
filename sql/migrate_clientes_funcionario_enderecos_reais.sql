/*
  Migração: coluna Clientes.Funcionario, tabela Funcionarios, endereços reais (BR + exterior)
  para clientes bi_fake_*@seed.local e até 1000 funcionários (somente Pais = Brasil).

  Executar no banco CacauParque após o seed BI (seed_bi_20k_clientes_e_52_atracoes.sql).
  Pode rodar mais de uma vez: endereços e flags seed são recalculados para bi_fake.
  Para renomear CriadoEm/AtualizadoEm e triggers de Funcionários, use também
  migrate_funcionarios_datainicio_datadesligamento.sql.

  Remoção (seed):
    DELETE f FROM dbo.Funcionarios f INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId
      WHERE c.Email LIKE N'bi_fake_%@seed.local';
    UPDATE dbo.Clientes SET Funcionario = 0 WHERE Email LIKE N'bi_fake_%@seed.local';
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ---------- DDL ---------- */

IF COL_LENGTH('dbo.Clientes', 'Funcionario') IS NULL
BEGIN
  ALTER TABLE dbo.Clientes ADD Funcionario BIT NOT NULL
    CONSTRAINT DF_Clientes_Funcionario DEFAULT (0);
END;
GO

IF OBJECT_ID('dbo.Funcionarios', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Funcionarios (
    Id INT IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_Funcionarios PRIMARY KEY,
    FuncionarioId INT NOT NULL,
    Ativos BIT NOT NULL
      CONSTRAINT DF_Funcionarios_Ativos DEFAULT (1),
    Setor NVARCHAR(80) NULL,
    Cargo NVARCHAR(80) NULL,
    Nivel NVARCHAR(20) NULL,
    DataInicio DATETIME2(0) NOT NULL
      CONSTRAINT DF_Funcionarios_DataInicio DEFAULT (SYSDATETIME()),
    DataDesligamento DATETIME2(0) NULL,
    CONSTRAINT FK_Funcionarios_Clientes
      FOREIGN KEY (FuncionarioId) REFERENCES dbo.Clientes(Id) ON DELETE CASCADE,
    CONSTRAINT UX_Funcionarios_FuncionarioId UNIQUE (FuncionarioId)
  );
END;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Ativos') IS NULL
BEGIN
  ALTER TABLE dbo.Funcionarios ADD Ativos BIT NOT NULL
    CONSTRAINT DF_Funcionarios_Ativos_Compat DEFAULT (1);
END;
GO

IF COL_LENGTH('dbo.Funcionarios', 'FuncionarioId') IS NULL
  AND COL_LENGTH('dbo.Funcionarios', 'ClienteId') IS NOT NULL
BEGIN
  EXEC sp_rename 'dbo.Funcionarios.ClienteId', 'FuncionarioId', 'COLUMN';
END;
GO

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
  DECLARE @fdc_br sysname;
  SELECT @fdc_br = dc.name
  FROM sys.default_constraints dc
  INNER JOIN sys.columns c
    ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
    AND c.name = N'DataDesligamento';
  IF @fdc_br IS NOT NULL
  BEGIN
    DECLARE @sql_drop_fdc_br NVARCHAR(400);
    SET @sql_drop_fdc_br = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@fdc_br);
    EXEC(@sql_drop_fdc_br);
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

IF OBJECT_ID(N'dbo.TR_Clientes_SyncFuncionarios', N'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_Clientes_SyncFuncionarios;
GO

IF COL_LENGTH('dbo.Funcionarios', 'Nome') IS NOT NULL
  ALTER TABLE dbo.Funcionarios DROP COLUMN Nome;
GO

BEGIN TRAN;

/* ---------- Pool de endereços (CEP/logradouros reais ou formatos postais válidos) ---------- */
DECLARE @Pool TABLE (
  k INT NOT NULL PRIMARY KEY,
  Rua NVARCHAR(160) NOT NULL,
  Bairro NVARCHAR(120) NOT NULL,
  Pais NVARCHAR(80) NOT NULL,
  Cep NVARCHAR(20) NOT NULL,
  Numero NVARCHAR(20) NOT NULL
);

INSERT INTO @Pool (k, Rua, Bairro, Pais, Cep, Numero) VALUES
(0,  N'Av. Paulista',                    N'Bela Vista — São Paulo/SP',           N'Brasil',         N'01310100', N'1578'),
(1,  N'Rua Oscar Freire',                N'Jardim Paulista — São Paulo/SP',      N'Brasil',         N'01426001', N'379'),
(2,  N'Rua Augusta',                     N'Consolação — São Paulo/SP',           N'Brasil',         N'01412000', N'2690'),
(3,  N'Av. Atlântica',                   N'Copacabana — Rio de Janeiro/RJ',    N'Brasil',         N'22021000', N'1100'),
(4,  N'Rua XV de Novembro',              N'Centro — Curitiba/PR',                N'Brasil',         N'80020310', N'502'),
(5,  N'Rua da Praia',                    N'Centro Histórico — Porto Alegre/RS', N'Brasil',         N'90010270', N'920'),
(6,  N'SCS Q. 5',                        N'Asa Sul — Brasília/DF',               N'Brasil',         N'70301515', N'12'),
(7,  N'Av. Afonso Pena',                 N'Centro — Belo Horizonte/MG',         N'Brasil',         N'30130008', N'786'),
(8,  N'Rua do Mercado',                  N'Pelourinho — Salvador/BA',            N'Brasil',         N'40026280', N'44'),
(9,  N'Av. Beira Mar',                   N'Meireles — Fortaleza/CE',             N'Brasil',         N'60165121', N'2200'),
(10, N'Rua 24 Horas',                    N'Aeroporto — Goiânia/GO',              N'Brasil',         N'74070140', N'106'),
(11, N'Av. Jorge Schimmelpfeng',         N'Centro — Manaus/AM',                  N'Brasil',         N'69025100', N'258'),
(12, N'Rua Halfeld',                     N'Centro — Juiz de Fora/MG',           N'Brasil',         N'36010230', N'285'),
(13, N'Av. João Pessoa',                 N'Torre — Natal/RN',                   N'Brasil',         N'59040430', N'800'),
(14, N'Rua das Palmeiras',               N'Campo Grande — Cariacica/ES',        N'Brasil',         N'29146150', N'55'),
(15, N'Av. Maringá',                     N'Zona 1 — Maringá/PR',                 N'Brasil',         N'87013260', N'1201'),
(16, N'Rua Barão de Capanema',           N'Batel — Curitiba/PR',                 N'Brasil',         N'80420070', N'600'),
(17, N'Av. João Wallig',                 N'Passo d Areia — Porto Alegre/RS',    N'Brasil',         N'91340000', N'1800'),
(18, N'Av. Sete de Setembro',            N'Centro — Florianópolis/SC',          N'Brasil',         N'88015307', N'1100'),
(19, N'Av. Boa Viagem',                  N'Pina — Recife/PE',                   N'Brasil',         N'51111000', N'3460'),
(20, N'Rua do Bom Jesus',                N'Recife Antigo — Recife/PE',           N'Brasil',         N'50030280', N'125'),
(21, N'Rua Chile',                       N'Centro — Rio de Janeiro/RJ',         N'Brasil',         N'20031170', N'35'),
(22, N'Praça da Sé',                     N'Sé — São Paulo/SP',                  N'Brasil',         N'01001000', N's/n'),
(23, N'Rua Haddock Lobo',                N'Cerqueira César — São Paulo/SP',     N'Brasil',         N'01414902', N'595'),
(24, N'Av. Brigadeiro Faria Lima',       N'Itaim Bibi — São Paulo/SP',         N'Brasil',         N'01452000', N'2300'),
(25, N'Rua das Flores',                  N'Centro — Florianópolis/SC',         N'Brasil',         N'88020300', N'88'),
(26, N'Av. Ipiranga',                    N'República — São Paulo/SP',          N'Brasil',         N'01046010', N'344'),
(27, N'Rua Cel. Pedro Benedet',          N'Centro — Joinville/SC',              N'Brasil',         N'89210000', N'505'),
(28, N'Av. Santos Dumont',               N'Centro — Campina Grande/PB',         N'Brasil',         N'58400145', N'800'),
(29, N'Rua Grande',                      N'Centro — São Luís/MA',               N'Brasil',         N'65010110', N'357'),
(30, N'Av. Frei Serafim',                N'Centro — Teresina/PI',               N'Brasil',         N'64000220', N'1068'),
(31, N'Rua da Aurora',                  N'Boa Vista — Recife/PE',              N'Brasil',         N'50050290', N'387'),
(32, N'Av. Joaquim Nabuco',             N'Centro — Recife/PE',                 N'Brasil',         N'50010400', N'200'),
(33, N'Rua Guilhermina Guinle',        N'Botafogo — Rio de Janeiro/RJ',       N'Brasil',         N'22270050', N'211'),
(34, N'Rua Barata Ribeiro',               N'Copacabana — Rio de Janeiro/RJ',     N'Brasil',         N'22040001', N'502'),
(35, N'Av. Rio Branco',                 N'Centro — Rio de Janeiro/RJ',         N'Brasil',         N'20040002', N'120'),
(36, N'Rua da Consolação',              N'Consolação — São Paulo/SP',          N'Brasil',         N'01302000', N'2477'),
(37, N'Av. Rebouças',                   N'Pinheiros — São Paulo/SP',          N'Brasil',         N'05402000', N'1325'),
(38, N'Rua Treze de Maio',              N'Centro — Belém/PA',                 N'Brasil',         N'66019230', N'400'),
(39, N'Av. Eduardo Ribeiro',            N'Centro — Manaus/AM',                 N'Brasil',         N'69010100', N'520'),
(40, N'Rua Espírito Santo',             N'Funcionários — Belo Horizonte/MG',  N'Brasil',         N'30160243', N'1111'),
(41, N'Av. Carandaí',                   N'Funcionários — Belo Horizonte/MG',    N'Brasil',         N'30180520', N'777'),
(42, N'Av. ACM',                        N'Pituba — Salvador/BA',               N'Brasil',         N'41810000', N'1250'),
(43, N'Rua Chile',                      N'Centro — Salvador/BA',               N'Brasil',         N'40020000', N'40'),
(44, N'Av. Beira-Mar',                  N'Centro — Aracaju/SE',               N'Brasil',         N'49010350', N'1880'),
(45, N'Rua Padre Anchieta',             N'Bigorrilho — Curitiba/PR',          N'Brasil',         N'80730000', N'1280'),
(46, N'Av. Getúlio Vargas',             N'Batel — Curitiba/PR',                N'Brasil',         N'80240000', N'200'),
(47, N'Av. Alberto Torres',            N'São Francisco — Niterói/RJ',        N'Brasil',         N'24360460', N'451'),
(48, N'Rua das Pedras',                 N'Centro — Búzios/RJ',                 N'Brasil',         N'28950180', N'150'),
(49, N'Rua Felipe Schmidt',             N'Centro — Chapecó/SC',               N'Brasil',         N'89801001', N'645'),
(50, N'Av. Brasil',                     N'Centro — Cascavel/PR',               N'Brasil',         N'85810110', N'4500'),
(51, N'Rua Heitor Stockler de Franca', N'Batel — Curitiba/PR',                N'Brasil',         N'80430000', N'396'),
(52, N'Av. W2 Sul',                     N'Asa Sul — Brasília/DF',             N'Brasil',         N'70316000', N'102'),
(53, N'SQN 104',                        N'Asa Norte — Brasília/DF',            N'Brasil',         N'70712010', N'200'),
(54, N'Rua do Lavradio',                N'Lapa — Rio de Janeiro/RJ',          N'Brasil',         N'20230070', N'25'),
(55, N'Av. Borborema',                  N'Centro — Campina Grande/PB',         N'Brasil',         N'58401495', N'499'),
(56, N'Calle Florida',                  N'Microcentro — Buenos Aires',         N'Argentina',      N'C1005AAU', N'500'),
(57, N'Av. Corrientes',                 N'San Nicolás — Buenos Aires',         N'Argentina',      N'C1043AAS', N'1234'),
(58, N'Gran Vía',                       N'Centro — Madrid',                    N'Espanha',        N'28013',    N'25'),
(59, N'Rue de Rivoli',                  N'1er arr. — Paris',                 N'França',         N'75001',    N'100'),
(60, N'Fifth Avenue',                   N'Midtown — Nova York/NY',           N'Estados Unidos', N'10019',    N'725'),
(61, N'Baker Street',                   N'Marylebone — Londres',              N'Reino Unido',    N'NW16XE',   N'189'),
(62, N'Via del Corso',                  N'Centro — Roma',                      N'Itália',         N'00186',    N'301'),
(63, N'Kärntner Straße',                N'Innere Stadt — Viena',            N'Áustria',        N'1010',     N'15'),
(64, N'Av. 9 de Julio',                 N'San Telmo — Buenos Aires',          N'Argentina',      N'C1073ABA', N'200'),
(65, N'Orchard Road',                   N'Orchard — Singapura',                N'Singapura',      N'238801',   N'310'),
(66, N'Shibuya Crossing area',          N'Shibuya — Tóquio',                  N'Japão',          N'1500002',  N'1-2-3'),
(67, N'Paseo de la Reforma',            N'Juárez — Cidade do México',       N'México',         N'06600',    N'250'),
(68, N'Rua da Prata',                   N'Baixa — Lisboa',                    N'Portugal',       N'1100470',  N'78'),
(69, N'Bahnhofstrasse',                 N'Altstadt — Zurique',               N'Suíça',          N'8001',     N'50'),
(70, N'Sztefan Batory street area',     N'Sródmieście — Varsóvia',            N'Polônia',        N'00-517',   N'12'),
(71, N'Nathan Road',                    N'Jordan — Hong Kong',                 N'China (HK)',     N'999077',   N'400');

DECLARE @N INT = (SELECT COUNT(*) FROM @Pool);

;WITH alvo AS (
  SELECT
    e.Id AS EnderecoId,
    c.Id AS ClienteId,
    ABS(CHECKSUM(CAST(c.Id AS VARBINARY(12)))) AS h
  FROM dbo.Enderecos e
  INNER JOIN dbo.Clientes c ON c.Id = e.ClienteId
  WHERE c.Email LIKE N'bi_fake_%@seed.local'
)
UPDATE e
SET
  e.Rua = p.Rua,
  e.Bairro = p.Bairro,
  e.Pais = p.Pais,
  e.Cep = p.Cep,
  e.Numero = p.Numero,
  e.AtualizadoEm = SYSDATETIME()
FROM dbo.Enderecos e
INNER JOIN alvo a ON a.EnderecoId = e.Id
INNER JOIN @Pool p ON p.k = ((a.h % @N) + @N) % @N;

/* ---------- Funcionários: só bi_fake, só Brasil, no máximo 1000 com 1 ---------- */

UPDATE c
SET Funcionario = 0
FROM dbo.Clientes c
WHERE c.Email LIKE N'bi_fake_%@seed.local';

DELETE f
FROM dbo.Funcionarios f
INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId
WHERE c.Email LIKE N'bi_fake_%@seed.local';

;WITH br AS (
  SELECT c.Id, ROW_NUMBER() OVER (ORDER BY NEWID()) AS rn
  FROM dbo.Clientes c
  INNER JOIN dbo.Enderecos e ON e.ClienteId = c.Id
  WHERE c.Email LIKE N'bi_fake_%@seed.local'
    AND e.Pais = N'Brasil'
)
UPDATE c
SET Funcionario = 1
FROM dbo.Clientes c
INNER JOIN br ON br.Id = c.Id
WHERE br.rn <= 1000;

INSERT INTO dbo.Funcionarios (FuncionarioId, Ativos)
SELECT c.Id, 1
FROM dbo.Clientes c
WHERE c.Email LIKE N'bi_fake_%@seed.local'
  AND c.Funcionario = 1
  AND NOT EXISTS (SELECT 1 FROM dbo.Funcionarios f WHERE f.FuncionarioId = c.Id);

UPDATE dbo.Funcionarios
SET Ativos = CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 82 THEN 1 ELSE 0 END;

COMMIT TRAN;
GO

SELECT
  SUM(CASE WHEN c.Email LIKE N'bi_fake_%@seed.local' AND e.Pais = N'Brasil' THEN 1 ELSE 0 END) AS SeedBrasil,
  SUM(CASE WHEN c.Email LIKE N'bi_fake_%@seed.local' AND e.Pais <> N'Brasil' THEN 1 ELSE 0 END) AS SeedExterior,
  SUM(CASE WHEN c.Funcionario = 1 AND c.Email LIKE N'bi_fake_%@seed.local' THEN 1 ELSE 0 END) AS SeedFuncionarios
FROM dbo.Clientes c
LEFT JOIN dbo.Enderecos e ON e.ClienteId = c.Id
WHERE c.Email LIKE N'bi_fake_%@seed.local';
SELECT COUNT(*) AS LinhasFuncionarios FROM dbo.Funcionarios;
GO

