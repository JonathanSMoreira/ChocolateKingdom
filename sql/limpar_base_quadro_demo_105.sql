/*
  =============================================================================
  LIMPEZA + quadro demo em 4 ÁREAS (203 funcionários) — CUIDADO: apaga quase todos os clientes
  =============================================================================
  Mantém Clientes.Id = 1 (você = Gerente Geral do Administrativo).

  ÁREAS E COTAS:
  | Área           | Gerente (1) | Coordenadores (3) | Demais cargos |
  |----------------|-------------|-------------------|---------------|
  | Administrativo | Gerente Geral (id1) + Gerente Adm | Coord Adm (3) | 10 Sup. Op., 71 Asst. Adm. |
  | Tecnologia     | Gerente de Tecnologia | Coordenador de TI (3) | 15 Analista TI, 15 Asst. TI |
  | Manutenção     | Gerente de Manutenção | Coordenador de Manutenção (3) | 25 Mecânicos |
  | Operações      | Gerente de Operações | Coordenador de Operações (3) | 50 Auxiliar de Operações |

  IDs:
    1        = Gerente Geral (Administrativo)
    2–86     = Administrativo (sem TI): Gerente Adm, 3 coord, 10 sup, 71 assistentes
    87–90    = Gestão Tecnologia (1 gerente + 3 coord)
    91–105   = Analista de TI (setor Tecnologia)
    106–134  = Manutenção (29)
    135–188  = Operações (54)
    189–203  = Assistente de TI (setor Tecnologia), +15

  Total = 203.

  Ids 2–203 em Clientes: nome + sobrenome brasileiros variados; apelido é diminutivo ou forma curta ligada ao primeiro nome.
  E-mail demo: colab.{Id}@emp.demo.br (único). Id 1 não é alterado por este bloco.

  Senha demo todos: Demo@105 (bcrypt no DECLARE @SenhaDemo).
  BACKUP antes. Ajuste USE [CacauParque]. Opcional: acrescenta linhas em CadastroCargo para novos nomes.

  Nível (dbo.Funcionarios.Nivel) p/ Assistente Adm., Assistente de TI, Analista de TI, Mecânico, Auxiliar de Op.:
  ~12% Júnior, ~44% Pleno, restante Sênior (por cargo, ordenado por FuncionarioId). Não altera Id = 1.

  dbo.Funcionarios.StatusTrabalho: após o script fica 0 para todos (Não); virada para 1 só via botão Sim na app.

  Visitantes (~25): Clientes com Funcionario = 0; endereços reais (vias/locais públicos) e países variados;
  Senha igual @SenhaDemo. Sem linha em dbo.Funcionarios (regra do trigger).

  Endereço no app (cadastro): GET/PUT /api/clientes/:id/endereco ↔ dbo.Enderecos
    Rua → Rua | Bairro → Bairro | País → Pais | CEP → Cep | Número → Numero
  Funcionários (Id 1–203) recebem linha em Enderecos (SP/região). Visitantes já têm Enderecos no INSERT próprio.
  =============================================================================
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

USE [CacauParque];
GO

DECLARE @SenhaDemo NVARCHAR(255) = N'$2b$12$0Zcd0HNByU2zL4gGRoi62O9PlI7YtrVTTex94G/fmLqeSnfv997QO';
DECLARE @SetorAdm NVARCHAR(80) = N'Administrativo';
DECLARE @SetorTec NVARCHAR(80) = N'Tecnologia';
DECLARE @SetorMnt NVARCHAR(80) = N'Manutenção';
DECLARE @SetorOpe NVARCHAR(80) = N'Operações';

IF OBJECT_ID('dbo.Clientes', 'U') IS NULL
BEGIN
  RAISERROR('Tabela dbo.Clientes não existe.', 16, 1);
  RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM dbo.Clientes WHERE Id = 1)
BEGIN
  RAISERROR('Não existe Clientes.Id = 1. Ajuste o script antes.', 16, 1);
  RETURN;
END;

BEGIN TRY
  BEGIN TRAN;

  IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NOT NULL
    DELETE FROM dbo.PontoEletronicoDia;

  IF OBJECT_ID('dbo.AuthExterno', 'U') IS NOT NULL
    DELETE FROM dbo.AuthExterno;

  IF OBJECT_ID('dbo.Enderecos', 'U') IS NOT NULL
    DELETE FROM dbo.Enderecos;

  IF OBJECT_ID('dbo.Funcionarios', 'U') IS NOT NULL
    DELETE FROM dbo.Funcionarios WHERE FuncionarioId > 1;

  DELETE FROM dbo.Clientes WHERE Id > 1;

  DBCC CHECKIDENT ('dbo.Clientes', RESEED, 1);

  /* Catálogo: cargos extras da demo (se a tabela existir) */
  IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NOT NULL
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.CadastroCargo WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Gerente de Manutenção')
      INSERT INTO dbo.CadastroCargo (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
      VALUES (N'Gerente de Manutenção', 1, 1, 28, N'Manutenção');
    IF NOT EXISTS (SELECT 1 FROM dbo.CadastroCargo WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Mecânico')
      INSERT INTO dbo.CadastroCargo (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
      VALUES (N'Mecânico', 1, 1, 185, N'Manutenção');
    IF NOT EXISTS (SELECT 1 FROM dbo.CadastroCargo WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Gerente de Tecnologia')
      INSERT INTO dbo.CadastroCargo (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
      VALUES (N'Gerente de Tecnologia', 1, 1, 26, N'TI');
    IF NOT EXISTS (SELECT 1 FROM dbo.CadastroCargo WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Assistente de TI')
      INSERT INTO dbo.CadastroCargo (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
      VALUES (N'Assistente de TI', 1, 1, 175, N'TI');
  END;

  /* Id 1 — Gerente Geral */
  UPDATE dbo.Clientes
  SET
    Nome = N'Gerente',
    Sobrenome = N'Geral',
    Apelido = N'Gerente',
    Email = N'gerente.geral@demo.local',
    SenhaHash = @SenhaDemo,
    Funcionario = 1,
    Ativo = 1,
    AtualizadoEm = SYSDATETIME()
  WHERE Id = 1;

  IF NOT EXISTS (SELECT 1 FROM dbo.Funcionarios WHERE FuncionarioId = 1)
    INSERT INTO dbo.Funcionarios (FuncionarioId, Ativos, Setor, Cargo, DataInicio, DataDesligamento)
    VALUES (1, 1, @SetorAdm, N'Gerente Geral', SYSDATETIME(), NULL);
  ELSE
    UPDATE dbo.Funcionarios
    SET Ativos = 1, Setor = @SetorAdm, Cargo = N'Gerente Geral'
    WHERE FuncionarioId = 1;

  DECLARE @n INT = 2;
  DECLARE @email NVARCHAR(180);
  DECLARE @apelido NVARCHAR(120);
  DECLARE @nomeIns NVARCHAR(120);
  DECLARE @sobIns NVARCHAR(120);

  DECLARE @Prenomes TABLE (ord SMALLINT PRIMARY KEY, Nome NVARCHAR(120), Apelido NVARCHAR(120));
  INSERT INTO @Prenomes (ord, Nome, Apelido) VALUES
    (1,  N'Ana',        N'Aninha'),
    (2,  N'João',       N'Jão'),
    (3,  N'Maria',      N'Mari'),
    (4,  N'Pedro',      N'Pepe'),
    (5,  N'Juliana',    N'Ju'),
    (6,  N'Ricardo',    N'Rick'),
    (7,  N'Fernanda',   N'Nanda'),
    (8,  N'Lucas',      N'Lu'),
    (9,  N'Patrícia',   N'Pati'),
    (10, N'Roberto',    N'Beto'),
    (11, N'Camila',     N'Cami'),
    (12, N'Daniel',     N'Dani'),
    (13, N'Larissa',    N'Lari'),
    (14, N'Felipe',     N'Lipe'),
    (15, N'Amanda',     N'Mandinha'),
    (16, N'Bruno',      N'Bru'),
    (17, N'Carolina',   N'Carol'),
    (18, N'Thiago',     N'Tiaguinho'),
    (19, N'Mariana',    N'Marianinha'),
    (20, N'Gustavo',    N'Guga'),
    (21, N'Letícia',    N'Lê'),
    (22, N'Rafael',     N'Rafa'),
    (23, N'Beatriz',    N'Bia'),
    (24, N'André',      N'Dé'),
    (25, N'Vanessa',    N'Van'),
    (26, N'Eduardo',    N'Duda'),
    (27, N'Sabrina',    N'Sabi'),
    (28, N'Rodrigo',    N'Digo'),
    (29, N'Priscila',   N'Pri'),
    (30, N'Vinícius',   N'Vini'),
    (31, N'Tatiane',    N'Tati'),
    (32, N'Leonardo',   N'Léo');

  DECLARE @Sobrenomes TABLE (ord SMALLINT PRIMARY KEY, Sobrenome NVARCHAR(120));
  INSERT INTO @Sobrenomes (ord, Sobrenome) VALUES
    (1, N'Silva'), (2, N'Santos'), (3, N'Oliveira'), (4, N'Souza'), (5, N'Rodrigues'),
    (6, N'Ferreira'), (7, N'Alves'), (8, N'Pereira'), (9, N'Lima'), (10, N'Gomes'),
    (11, N'Costa'), (12, N'Ribeiro'), (13, N'Martins'), (14, N'Carvalho'), (15, N'Rocha'),
    (16, N'Almeida'), (17, N'Nascimento'), (18, N'Araújo'), (19, N'Melo'), (20, N'Barbosa'),
    (21, N'Cardoso'), (22, N'Correia'), (23, N'Dias'), (24, N'Freitas'), (25, N'Cunha'),
    (26, N'Moura'), (27, N'Azevedo');

  WHILE @n <= 203
  BEGIN
    SELECT @nomeIns = Nome, @apelido = Apelido
    FROM @Prenomes
    WHERE ord = ((@n - 2) % 32) + 1;

    SELECT @sobIns = Sobrenome
    FROM @Sobrenomes
    WHERE ord = (((@n - 2) * 7 + 11) % 27) + 1;

    SET @email = CONCAT(
      N'colab.',
      CAST(@n AS NVARCHAR(10)),
      N'@emp.demo.br'
    );

    INSERT INTO dbo.Clientes (
      Nome, Sobrenome, Apelido, Email, SenhaHash, Funcionario, Ativo,
      CriadoEm, AtualizadoEm
    )
    VALUES (
      @nomeIns,
      @sobIns,
      @apelido,
      @email,
      @SenhaDemo,
      1,
      1,
      SYSDATETIME(),
      SYSDATETIME()
    );
    SET @n += 1;
  END;

  /* Uma linha em Funcionarios por Cliente (FK); senão os UPDATEs abaixo não alteram nada. */
  INSERT INTO dbo.Funcionarios (FuncionarioId, Ativos, Setor, Cargo, DataInicio, DataDesligamento)
  SELECT c.Id, 1, @SetorAdm, N'', SYSDATETIME(), NULL
  FROM dbo.Clientes c
  WHERE c.Id BETWEEN 2 AND 203
    AND NOT EXISTS (SELECT 1 FROM dbo.Funcionarios f WHERE f.FuncionarioId = c.Id);

  /* -------- Administrativo: 2..86 (71 assistentes: 16..86) -------- */
  UPDATE dbo.Funcionarios SET Setor = @SetorAdm, Cargo = N'Gerente Administrativo' WHERE FuncionarioId = 2;

  UPDATE dbo.Funcionarios SET Setor = @SetorAdm, Cargo = N'Coordenador Administrativo' WHERE FuncionarioId IN (3, 4, 5);

  UPDATE dbo.Funcionarios SET Setor = @SetorAdm, Cargo = N'Supervisor Operacional' WHERE FuncionarioId BETWEEN 6 AND 15;

  UPDATE dbo.Funcionarios SET Setor = @SetorAdm, Cargo = N'Assistente Administrativo' WHERE FuncionarioId BETWEEN 16 AND 86;

  /* -------- Tecnologia: 87..105 + 189..203 -------- */
  UPDATE dbo.Funcionarios SET Setor = @SetorTec, Cargo = N'Gerente de Tecnologia' WHERE FuncionarioId = 87;

  UPDATE dbo.Funcionarios SET Setor = @SetorTec, Cargo = N'Coordenador de TI' WHERE FuncionarioId IN (88, 89, 90);

  UPDATE dbo.Funcionarios SET Setor = @SetorTec, Cargo = N'Analista de TI' WHERE FuncionarioId BETWEEN 91 AND 105;

  UPDATE dbo.Funcionarios SET Setor = @SetorTec, Cargo = N'Assistente de TI' WHERE FuncionarioId BETWEEN 189 AND 203;

  /* -------- Manutenção: 106..134 (1+3+25) -------- */
  UPDATE dbo.Funcionarios SET Setor = @SetorMnt, Cargo = N'Gerente de Manutenção' WHERE FuncionarioId = 106;

  UPDATE dbo.Funcionarios SET Setor = @SetorMnt, Cargo = N'Coordenador de Manutenção' WHERE FuncionarioId IN (107, 108, 109);

  UPDATE dbo.Funcionarios SET Setor = @SetorMnt, Cargo = N'Mecânico' WHERE FuncionarioId BETWEEN 110 AND 134;

  /* -------- Operações: 135..188 (1+3+50) -------- */
  UPDATE dbo.Funcionarios SET Setor = @SetorOpe, Cargo = N'Gerente de Operações' WHERE FuncionarioId = 135;

  UPDATE dbo.Funcionarios SET Setor = @SetorOpe, Cargo = N'Coordenador de Operações' WHERE FuncionarioId IN (136, 137, 138);

  UPDATE dbo.Funcionarios SET Setor = @SetorOpe, Cargo = N'Auxiliar de Operações' WHERE FuncionarioId BETWEEN 139 AND 188;

  /* Nível: cargos de base — poucos Júnior; Pleno e Sênior ~ metade do restante cada */
  ;WITH r AS (
    SELECT FuncionarioId, ROW_NUMBER() OVER (ORDER BY FuncionarioId) AS rn, COUNT(*) OVER () AS c
    FROM dbo.Funcionarios
    WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Assistente Administrativo'
  )
  UPDATE f SET Nivel = CASE
    WHEN r.rn <= CEILING(r.c * 0.12) THEN N'Júnior'
    WHEN r.rn <= CEILING(r.c * 0.12) + FLOOR(r.c * 0.44) THEN N'Pleno'
    ELSE N'Sênior'
  END
  FROM dbo.Funcionarios f INNER JOIN r ON r.FuncionarioId = f.FuncionarioId;

  ;WITH r AS (
    SELECT FuncionarioId, ROW_NUMBER() OVER (ORDER BY FuncionarioId) AS rn, COUNT(*) OVER () AS c
    FROM dbo.Funcionarios
    WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Assistente de TI'
  )
  UPDATE f SET Nivel = CASE
    WHEN r.rn <= CEILING(r.c * 0.12) THEN N'Júnior'
    WHEN r.rn <= CEILING(r.c * 0.12) + FLOOR(r.c * 0.44) THEN N'Pleno'
    ELSE N'Sênior'
  END
  FROM dbo.Funcionarios f INNER JOIN r ON r.FuncionarioId = f.FuncionarioId;

  ;WITH r AS (
    SELECT FuncionarioId, ROW_NUMBER() OVER (ORDER BY FuncionarioId) AS rn, COUNT(*) OVER () AS c
    FROM dbo.Funcionarios
    WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Analista de TI'
  )
  UPDATE f SET Nivel = CASE
    WHEN r.rn <= CEILING(r.c * 0.12) THEN N'Júnior'
    WHEN r.rn <= CEILING(r.c * 0.12) + FLOOR(r.c * 0.44) THEN N'Pleno'
    ELSE N'Sênior'
  END
  FROM dbo.Funcionarios f INNER JOIN r ON r.FuncionarioId = f.FuncionarioId;

  ;WITH r AS (
    SELECT FuncionarioId, ROW_NUMBER() OVER (ORDER BY FuncionarioId) AS rn, COUNT(*) OVER () AS c
    FROM dbo.Funcionarios
    WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Mecânico'
  )
  UPDATE f SET Nivel = CASE
    WHEN r.rn <= CEILING(r.c * 0.12) THEN N'Júnior'
    WHEN r.rn <= CEILING(r.c * 0.12) + FLOOR(r.c * 0.44) THEN N'Pleno'
    ELSE N'Sênior'
  END
  FROM dbo.Funcionarios f INNER JOIN r ON r.FuncionarioId = f.FuncionarioId;

  ;WITH r AS (
    SELECT FuncionarioId, ROW_NUMBER() OVER (ORDER BY FuncionarioId) AS rn, COUNT(*) OVER () AS c
    FROM dbo.Funcionarios
    WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Auxiliar de Operações'
  )
  UPDATE f SET Nivel = CASE
    WHEN r.rn <= CEILING(r.c * 0.12) THEN N'Júnior'
    WHEN r.rn <= CEILING(r.c * 0.12) + FLOOR(r.c * 0.44) THEN N'Pleno'
    ELSE N'Sênior'
  END
  FROM dbo.Funcionarios f INNER JOIN r ON r.FuncionarioId = f.FuncionarioId;

  /* StatusTrabalho: 0 = Não (padrão); 1 = Sim só quando o colaborador ativa no app (PUT status-trabalho). */
  IF COL_LENGTH('dbo.Funcionarios', 'StatusTrabalho') IS NOT NULL
    UPDATE dbo.Funcionarios SET StatusTrabalho = 0 WHERE FuncionarioId BETWEEN 1 AND 203;

  /* Funcionários: uma linha em Enderecos por ClienteId (colunas alinhadas ao modal do app). */
  IF OBJECT_ID('dbo.Enderecos', 'U') IS NOT NULL
  BEGIN
    INSERT INTO dbo.Enderecos (ClienteId, Rua, Bairro, Pais, Cep, Numero, CriadoEm, AtualizadoEm)
    SELECT
      c.Id,
      tmpl.Rua,
      tmpl.Bairro,
      N'Brasil',
      tmpl.Cep,
      CAST(80 + (c.Id * 13) % 2920 AS NVARCHAR(20)),
      SYSDATETIME(),
      SYSDATETIME()
    FROM dbo.Clientes c
    INNER JOIN (
      SELECT idx, Rua, Bairro, Cep FROM (VALUES
        (0,  N'Av. Paulista',                    N'Bela Vista',                 N'01310-100'),
        (1,  N'Rua Augusta',                    N'Consolação',                 N'01305-100'),
        (2,  N'Av. Brigadeiro Faria Lima',     N'Pinheiros',                  N'04538-132'),
        (3,  N'Rua Oscar Freire',               N'Jardins',                    N'01426-001'),
        (4,  N'Av. Rebouças',                   N'Pinheiros',                  N'05402-600'),
        (5,  N'Rua Henrique Schaumann',         N'Pinheiros',                  N'05413-010'),
        (6,  N'Av. Santo Amaro',                N'Brooklin',                  N'04701-002'),
        (7,  N'Rua Vergueiro',                  N'Vila Mariana',              N'04101-100'),
        (8,  N'Av. Ipiranga',                   N'República',                 N'01046-010'),
        (9,  N'Rua da Consolação',              N'Consolação',                N'01302-000'),
        (10, N'Av. Angélica',                   N'Consolação',                 N'01228-200'),
        (11, N'Rua Teodoro Sampaio',            N'Pinheiros',                  N'05406-200'),
        (12, N'Av. Eusébio Matoso',             N'Butantã',                    N'05508-000'),
        (13, N'Alameda Santos',                 N'Jardim Paulista',            N'01419-002'),
        (14, N'Rua Estados Unidos',             N'Jardim América',            N'01427-000'),
        (15, N'Av. Sumaré',                     N'Perdizes',                  N'05016-090'),
        (16, N'Rua Cardoso de Almeida',        N'Perdizes',                   N'05013-001'),
        (17, N'Rua Peixoto Gomide',            N'Jardim Paulista',          N'01409-000'),
        (18, N'Av. Cidade Jardim',             N'Jardim Guedala',             N'05675-030'),
        (19, N'Rua Prof. Artur Ramos',         N'Pinheiros',                 N'05454-011'),
        (20, N'Av. Pres. Juscelino Kubitschek', N'Itaim Bibi',               N'04543-011'),
        (21, N'Rua Dr. César',                  N'Santa Cecília',            N'01230-020'),
        (22, N'Alameda Campinas',               N'Jardim Paulista',           N'01404-100'),
        (23, N'Av. Hélio Pellegrino',          N'Vila Nova Conceição',       N'04513-080')
      ) AS t(idx, Rua, Bairro, Cep)
    ) AS tmpl ON tmpl.idx = (c.Id % 24)
    WHERE c.Funcionario = 1
      AND c.Id BETWEEN 1 AND 203
      AND NOT EXISTS (SELECT 1 FROM dbo.Enderecos e WHERE e.ClienteId = c.Id);
  END;

  /*
    Visitantes: não funcionários (Funcionario = 0). Endereços = logradouros/locais reais (CEP/códigos postais públicos).
    E-mail único → usado para amarrar INSERT em Enderecos.
  */
  INSERT INTO dbo.Clientes (
    Nome, Sobrenome, Apelido, Email, SenhaHash, Funcionario, Ativo,
    CriadoEm, AtualizadoEm, DataNascimento, Telefone, Documento, FotoPerfil
  )
  SELECT
    v.Nome, v.Sobrenome, v.Apelido, v.Email, @SenhaDemo, 0, 1,
    SYSDATETIME(), SYSDATETIME(), v.DataNascimento, v.Telefone, v.Documento, v.FotoPerfil
  FROM (VALUES
    (N'James', N'Morrison', N'Jim', N'visitante.us.dc@demo.world', CAST(N'1978-03-14' AS DATE), N'+1 202-456-1111', N'US-PASSPORT-780314001', N'https://picsum.photos/seed/vis-us-dc/200/200', N'1600 Pennsylvania Avenue NW', N'Federal Triangle', N'United States', N'20500', N'1600'),
    (N'Emma', N'Wilson', N'Emmy', N'visitante.uk.london@demo.world', CAST(N'1990-07-22' AS DATE), N'+44 20 7219 4272', N'UK-PASS-EMW90', N'https://picsum.photos/seed/vis-uk/200/200', N'10 Downing Street', N'Westminster', N'United Kingdom', N'SW1A 2AA', N'10'),
    (N'Pierre', N'Dubois', N'Pierrot', N'visitante.fr.paris@demo.world', CAST(N'1985-11-08' AS DATE), N'+33 1 44 11 23 34', N'FR-ID-PDB85', N'https://picsum.photos/seed/vis-fr/200/200', N'6 Parvis Notre-Dame – Pl. Jean-Paul II', N'Île de la Cité', N'France', N'75004', N'6'),
    (N'Yuki', N'Tanaka', N'Yuki', N'visitante.jp.tokyo@demo.world', CAST(N'1995-01-30' AS DATE), N'+81 3-3211-5211', N'JP-ZAIRYU-YT95', N'https://picsum.photos/seed/vis-jp/200/200', N'1-1 Chiyoda', N'Chiyoda City', N'Japan', N'100-8111', N'1'),
    (N'Olivia', N'Chen', N'Liv', N'visitante.au.sydney@demo.world', CAST(N'1988-05-17' AS DATE), N'+61 2 9250 7111', N'AU-DL-OCH88', N'https://picsum.photos/seed/vis-au/200/200', N'Bennelong Point', N'Sydney CBD', N'Australia', N'NSW 2000', N'' ),
    (N'Klaus', N'Weber', N'Klaus', N'visitante.de.berlin@demo.world', CAST(N'1982-09-03' AS DATE), N'+49 30 2260', N'DE-P-KW82', N'https://picsum.photos/seed/vis-de/200/200', N'Pariser Platz', N'Mitte', N'Germany', N'10117', N'1'),
    (N'Giulia', N'Rossi', N'Giuly', N'visitante.it.roma@demo.world', CAST(N'1991-12-01' AS DATE), N'+39 06 3996 7700', N'IT-CF-GRO91', N'https://picsum.photos/seed/vis-it/200/200', N'Piazza del Colosseo', N'Celio', N'Italy', N'00184', N'1'),
    (N'Carlos', N'Martínez', N'Charly', N'visitante.es.madrid@demo.world', CAST(N'1987-04-25' AS DATE), N'+34 914 200 400', N'ES-DNI-CM87', N'https://picsum.photos/seed/vis-es/200/200', N'Calle Ruiz de Alarcón, 23', N'Los Jerónimos', N'Spain', N'28014', N'23'),
    (N'Beatriz', N'Almeida', N'Bia', N'visitante.pt.lisboa@demo.world', CAST(N'1993-06-18' AS DATE), N'+351 21 031 2700', N'PT-BI-BAL93', N'https://picsum.photos/seed/vis-pt/200/200', N'Praça do Comércio', N'Baixa', N'Portugal', N'1100-148', N''),
    (N'André', N'Lefèvre', N'Dédé', N'visitante.ca.ottawa@demo.world', CAST(N'1979-10-09' AS DATE), N'+1 613-992-4793', N'CA-CC-AL79', N'https://picsum.photos/seed/vis-ca/200/200', N'111 Wellington Street', N'Downtown Ottawa', N'Canada', N'ON K1A 0A9', N'111'),
    (N'Sofía', N'González', N'Sofi', N'visitante.mx.cdmx@demo.world', CAST(N'1994-02-28' AS DATE), N'+52 55 8647 5800', N'MX-INE-SG94', N'https://picsum.photos/seed/vis-mx/200/200', N'Av. Paseo de la Reforma 50', N'Juárez', N'Mexico', N'06600', N'50'),
    (N'Lucas', N'Silva', N'Lu', N'visitante.br.rio@demo.world', CAST(N'1986-08-12' AS DATE), N'+55 21 2553 9600', N'BR-RG-LS86', N'https://picsum.photos/seed/vis-br-rj/200/200', N'Av. Pasteur, 520', N'Urca', N'Brazil', N'22290-240', N'520'),
    (N'Natalia', N'Kowalski', N'Nata', N'visitante.pl.warsaw@demo.world', CAST(N'1992-11-11' AS DATE), N'+48 22 597 31 50', N'PL-PESEL-NK92', N'https://picsum.photos/seed/vis-pl/200/200', N'plac Zamkowy', N'Stare Miasto', N'Poland', N'00-277', N'1'),
    (N'Lars', N'Johansson', N'Lasse', N'visitante.se.stockholm@demo.world', CAST(N'1984-01-07' AS DATE), N'+46 8 405 10 00', N'SE-PN-LJ84', N'https://picsum.photos/seed/vis-se/200/200', N'Rådgatan 1', N'Norrmalm', N'Sweden', N'111 29', N'1'),
    (N'Ingrid', N'Nilsen', N'Inga', N'visitante.no.oslo@demo.world', CAST(N'1989-05-29' AS DATE), N'+47 22 31 12 12', N'NO-D-NI89', N'https://picsum.photos/seed/vis-no/200/200', N'Karl Johans gate 1', N'Sentral Oslo', N'Norway', N'0154', N'1'),
    (N'Hans', N'Christensen', N'Hansi', N'visitante.dk.cph@demo.world', CAST(N'1981-12-24' AS DATE), N'+45 33 92 33 33', N'DK-CP-HC81', N'https://picsum.photos/seed/vis-dk/200/200', N'Prins Jørgens Gård 1', N'Indre By', N'Denmark', N'1218', N'1'),
    (N'Elena', N'Popescu', N'Leni', N'visitante.ro.bucharest@demo.world', CAST(N'1996-03-05' AS DATE), N'+40 21 303 10 00', N'RO-CNP-EP96', N'https://picsum.photos/seed/vis-ro/200/200', N'Strada Izvor 2-4', N'Sector 5', N'Romania', N'050563', N'2-4'),
    (N'Dmitri', N'Volkov', N'Dima', N'visitante.ru.moscow@demo.world', CAST(N'1983-07-19' AS DATE), N'+7 495 695-37-76', N'RU-PAS-DV83', N'https://picsum.photos/seed/vis-ru/200/200', N'Red Square', N'Tverskoy District', N'Russia', N'109012', N'1'),
    (N'Mei', N'Wang', N'May', N'visitante.cn.beijing@demo.world', CAST(N'1990-10-10' AS DATE), N'+86 10 6512 8814', N'CN-ID-MW90', N'https://picsum.photos/seed/vis-cn/200/200', N'Tiananmen Square', N'Dongcheng', N'China', N'100006', N''),
    (N'Priya', N'Kapoor', N'Pri', N'visitante.in.newdelhi@demo.world', CAST(N'1991-04-02' AS DATE), N'+91 11 2301 0323', N'IN-AA-PK91', N'https://picsum.photos/seed/vis-in/200/200', N'Rajpath', N'Central Secretariat', N'India', N'110001', N''),
    (N'Ahmed', N'El-Masry', N'Ahmed', N'visitante.eg.cairo@demo.world', CAST(N'1980-06-16' AS DATE), N'+20 2 2794 3103', N'EG-NI-AE80', N'https://picsum.photos/seed/vis-eg/200/200', N'Midan Tahrir', N'Downtown Cairo', N'Egypt', N'11511', N''),
    (N'Thabo', N'Mokoena', N'Taps', N'visitante.za.capetown@demo.world', CAST(N'1987-02-20' AS DATE), N'+27 21 464 5000', N'ZA-ID-TM87', N'https://picsum.photos/seed/vis-za/200/200', N'Parliament Street', N'State Park', N'South Africa', N'8001', N'120'),
    (N'Isabella', N'Hernández', N'Isa', N'visitante.ar.buenosaires@demo.world', CAST(N'1993-08-08' AS DATE), N'+54 11 4342-6600', N'AR-DNI-IH93', N'https://picsum.photos/seed/vis-ar/200/200', N'Av. Pres. Ramón Castillo 3063', N'Núñez', N'Argentina', N'C1429CNU', N'3063'),
    (N'Kim', N'Min-jun', N'MJ', N'visitante.kr.seoul@demo.world', CAST(N'1997-12-12' AS DATE), N'+82 2-3703-3114', N'KR-RR-KMJ97', N'https://picsum.photos/seed/vis-kr/200/200', N'161 Sajik-ro', N'Jongno-gu', N'South Korea', N'03045', N'161'),
    (N'Chloe', N'Taylor', N'Clo', N'visitante.nz.wellington@demo.world', CAST(N'1985-01-25' AS DATE), N'+64 4-381 7000', N'NZ-DL-CT85', N'https://picsum.photos/seed/vis-nz/200/200', N'Molesworth Street', N'Thorndon', N'New Zealand', N'5011', N'101'),
    (N'Serge', N'Meier', N'Sergio', N'visitante.ch.zurich@demo.world', CAST(N'1977-09-11' AS DATE), N'+41 44 412 31 11', N'CH-AX-SM77', N'https://picsum.photos/seed/vis-ch/200/200', N'Bahnhofstrasse 1', N'Altstadt', N'Switzerland', N'8001', N'1'),
    (N'María', N'Fernández', N'Mari', N'visitante.cl.santiago@demo.world', CAST(N'1992-04-30' AS DATE), N'+56 2 2671 1000', N'CL-RUN-MF92', N'https://picsum.photos/seed/vis-cl/200/200', N'Av Libertador Bernardo O''Higgins 1449', N'Santiago Centro', N'Chile', N'8340518', N'1449'),
    (N'Nikos', N'Papadopoulos', N'Nick', N'visitante.gr.athens@demo.world', CAST(N'1984-06-06' AS DATE), N'+30 210 9238 333', N'GR-AM-NP84', N'https://picsum.photos/seed/vis-gr/200/200', N'Leoforos Vasilisis Amalias 10', N'Makrygianni', N'Greece', N'105 57', N'10'),
    (N'Fatima', N'Al-Farsi', N'Fafi', N'visitante.ae.dubai@demo.world', CAST(N'1995-05-25' AS DATE), N'+971 4 366 8888', N'AE-EID-FA95', N'https://picsum.photos/seed/vis-ae/200/200', N'Sheikh Mohammed bin Rashid Boulevard', N'Downtown Dubai', N'United Arab Emirates', N'', N'1'),
    (N'David', N'Cohen', N'Dave', N'visitante.il.jerusalem@demo.world', CAST(N'1976-11-19' AS DATE), N'+972 2-670-8111', N'IL-ID-DC76', N'https://picsum.photos/seed/vis-il/200/200', N'11 Vilhelm Shapira Street', N'Givat Ram', N'Israel', N'9190501', N'11'),
    (N'Amara', N'Okafor', N'Ama', N'visitante.ng.lagos@demo.world', CAST(N'1998-08-01' AS DATE), N'+234 1 263 4100', N'NG-NIN-AO98', N'https://picsum.photos/seed/vis-ng/200/200', N'Marina Road', N'Lagos Island', N'Nigeria', N'101223', N'26')
  ) AS v (
    Nome, Sobrenome, Apelido, Email,
    DataNascimento, Telefone, Documento, FotoPerfil,
    Rua, Bairro, Pais, Cep, Numero
  );

  IF OBJECT_ID('dbo.Enderecos', 'U') IS NOT NULL
  BEGIN
    INSERT INTO dbo.Enderecos (ClienteId, Rua, Bairro, Pais, Cep, Numero, CriadoEm, AtualizadoEm)
    SELECT
      c.Id,
      x.Rua,
      x.Bairro,
      x.Pais,
      CASE WHEN LTRIM(RTRIM(ISNULL(x.Cep, N''))) = N'' THEN N'n/a' ELSE LTRIM(RTRIM(x.Cep)) END,
      CASE WHEN LTRIM(RTRIM(ISNULL(x.Numero, N''))) = N'' THEN N'S/N' ELSE LTRIM(RTRIM(x.Numero)) END,
      SYSDATETIME(),
      SYSDATETIME()
    FROM dbo.Clientes c
    INNER JOIN (VALUES
      (N'visitante.us.dc@demo.world', N'1600 Pennsylvania Avenue NW', N'Federal Triangle', N'United States', N'20500', N'1600'),
      (N'visitante.uk.london@demo.world', N'10 Downing Street', N'Westminster', N'United Kingdom', N'SW1A 2AA', N'10'),
      (N'visitante.fr.paris@demo.world', N'6 Parvis Notre-Dame – Pl. Jean-Paul II', N'Île de la Cité', N'France', N'75004', N'6'),
      (N'visitante.jp.tokyo@demo.world', N'1-1 Chiyoda', N'Chiyoda City', N'Japan', N'100-8111', N'1'),
      (N'visitante.au.sydney@demo.world', N'Bennelong Point', N'Sydney CBD', N'Australia', N'NSW 2000', N''),
      (N'visitante.de.berlin@demo.world', N'Pariser Platz', N'Mitte', N'Germany', N'10117', N'1'),
      (N'visitante.it.roma@demo.world', N'Piazza del Colosseo', N'Celio', N'Italy', N'00184', N'1'),
      (N'visitante.es.madrid@demo.world', N'Calle Ruiz de Alarcón, 23', N'Los Jerónimos', N'Spain', N'28014', N'23'),
      (N'visitante.pt.lisboa@demo.world', N'Praça do Comércio', N'Baixa', N'Portugal', N'1100-148', N''),
      (N'visitante.ca.ottawa@demo.world', N'111 Wellington Street', N'Downtown Ottawa', N'Canada', N'ON K1A 0A9', N'111'),
      (N'visitante.mx.cdmx@demo.world', N'Av. Paseo de la Reforma 50', N'Juárez', N'Mexico', N'06600', N'50'),
      (N'visitante.br.rio@demo.world', N'Av. Pasteur, 520', N'Urca', N'Brazil', N'22290-240', N'520'),
      (N'visitante.pl.warsaw@demo.world', N'plac Zamkowy', N'Stare Miasto', N'Poland', N'00-277', N'1'),
      (N'visitante.se.stockholm@demo.world', N'Rådgatan 1', N'Norrmalm', N'Sweden', N'111 29', N'1'),
      (N'visitante.no.oslo@demo.world', N'Karl Johans gate 1', N'Sentral Oslo', N'Norway', N'0154', N'1'),
      (N'visitante.dk.cph@demo.world', N'Prins Jørgens Gård 1', N'Indre By', N'Denmark', N'1218', N'1'),
      (N'visitante.ro.bucharest@demo.world', N'Strada Izvor 2-4', N'Sector 5', N'Romania', N'050563', N'2-4'),
      (N'visitante.ru.moscow@demo.world', N'Red Square', N'Tverskoy District', N'Russia', N'109012', N'1'),
      (N'visitante.cn.beijing@demo.world', N'Tiananmen Square', N'Dongcheng', N'China', N'100006', N''),
      (N'visitante.in.newdelhi@demo.world', N'Rajpath', N'Central Secretariat', N'India', N'110001', N''),
      (N'visitante.eg.cairo@demo.world', N'Midan Tahrir', N'Downtown Cairo', N'Egypt', N'11511', N''),
      (N'visitante.za.capetown@demo.world', N'Parliament Street', N'State Park', N'South Africa', N'8001', N'120'),
      (N'visitante.ar.buenosaires@demo.world', N'Av. Pres. Ramón Castillo 3063', N'Núñez', N'Argentina', N'C1429CNU', N'3063'),
      (N'visitante.kr.seoul@demo.world', N'161 Sajik-ro', N'Jongno-gu', N'South Korea', N'03045', N'161'),
      (N'visitante.nz.wellington@demo.world', N'Molesworth Street', N'Thorndon', N'New Zealand', N'5011', N'101'),
      (N'visitante.ch.zurich@demo.world', N'Bahnhofstrasse 1', N'Altstadt', N'Switzerland', N'8001', N'1'),
      (N'visitante.cl.santiago@demo.world', N'Av Libertador Bernardo O''Higgins 1449', N'Santiago Centro', N'Chile', N'8340518', N'1449'),
      (N'visitante.gr.athens@demo.world', N'Leoforos Vasilisis Amalias 10', N'Makrygianni', N'Greece', N'105 57', N'10'),
      (N'visitante.ae.dubai@demo.world', N'Sheikh Mohammed bin Rashid Boulevard', N'Downtown Dubai', N'United Arab Emirates', N'', N'1'),
      (N'visitante.il.jerusalem@demo.world', N'11 Vilhelm Shapira Street', N'Givat Ram', N'Israel', N'9190501', N'11'),
      (N'visitante.ng.lagos@demo.world', N'Marina Road', N'Lagos Island', N'Nigeria', N'101223', N'26')
    ) AS x(Email, Rua, Bairro, Pais, Cep, Numero)
      ON c.Email COLLATE Latin1_General_CI_AI = x.Email COLLATE Latin1_General_CI_AI
    WHERE c.Funcionario = 0
      AND NOT EXISTS (SELECT 1 FROM dbo.Enderecos e WHERE e.ClienteId = c.Id);
  END;

  COMMIT TRAN;
  PRINT N'limpar_base_quadro_multiplas_areas: concluído (203 funcionários + visitantes Funcionario=0).';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  DECLARE @m NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(N'Erro: %s', 16, 1, @m);
END CATCH;
GO

/* Conferência: por setor e cargo */
SELECT f.Setor AS setor, f.Cargo AS cargo, COUNT(*) AS qtd
FROM dbo.Funcionarios f
INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId AND c.Funcionario = 1 AND c.Ativo = 1
GROUP BY f.Setor, f.Cargo
ORDER BY f.Setor, f.Cargo;

SELECT f.Cargo AS cargo, COUNT(*) AS qtd
FROM dbo.Funcionarios f
INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId AND c.Funcionario = 1 AND c.Ativo = 1
GROUP BY f.Cargo
ORDER BY f.Cargo;

SELECT COUNT(*) AS total_funcionarios
FROM dbo.Funcionarios f
INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId AND c.Funcionario = 1 AND c.Ativo = 1;

SELECT COUNT(*) AS total_clientes FROM dbo.Clientes;

SELECT COUNT(*) AS visitantes_nao_funcionario
FROM dbo.Clientes
WHERE Funcionario = 0 AND Ativo = 1;

SELECT f.Cargo AS cargo, f.Nivel AS nivel, COUNT(*) AS qtd
FROM dbo.Funcionarios f
INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId AND c.Funcionario = 1 AND c.Ativo = 1
WHERE f.Nivel IS NOT NULL
GROUP BY f.Cargo, f.Nivel
ORDER BY f.Cargo, f.Nivel;
GO
