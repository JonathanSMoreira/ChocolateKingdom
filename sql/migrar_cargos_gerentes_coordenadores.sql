/*
  Migração de cargos em dbo.Funcionarios (campo Cargo).

  IMPORTANTE
  - Este arquivo NÃO altera o banco até você executá-lo no SSMS (F5) na base correta.
  - Faça backup ou rode primeiro em cópia.

  Ajuste as quantidades na seção DECLARE abaixo antes de rodar.

  Regras (após ajuste dos parâmetros):
  1) Cargo exatamente "Gerente" → "Gerente Geral".
  2) "Gerente Administrativo": mantém @MaxGerenteAdministrativo (menores FuncionarioId); demais → "Supervisor Administrativo".
  3) "Gerente de Operações": mantém @MaxGerenteOperacoes; demais → "Supervisor de Operações".
  4) "Coordenador Administrativo": mantém @MaxCoordenadorAdministrativo; demais → "Analista Administrativo".
  5) "Coordenador Geral": redistribui em 6 tipos (round-robin por FuncionarioId):
        Coordenador de TI, Coordenador Segurança, Coordenador de Operações,
        Coordenador de Manutenção, Coordenador de Atendimento, Coordenador de Alimentos.
     São permitidas até @MaxRodadasCoordenadorGeral rodadas completas (6 pessoas por rodada).
     Ex.: 3 rodadas = até 18 coordenadores nesses cargos; excedentes → "Supervisor Operacional".

  Compatibilidade: SQL Server.
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ========== Ajuste só estes números (quantidade que permanece no cargo “alto”) ========== */
DECLARE @MaxGerenteAdministrativo INT = 1;   /* titulares "Gerente Administrativo" */
DECLARE @MaxGerenteOperacoes INT = 1;         /* titulares "Gerente de Operações" */
DECLARE @MaxCoordenadorAdministrativo INT = 3; /* titulares "Coordenador Administrativo" */
DECLARE @MaxRodadasCoordenadorGeral INT = 3;   /* rodadas do round-robin nos 6 tipos (3×6 = 18 no teto) */
/* ======================================================================================== */

BEGIN TRY
  BEGIN TRAN;

  /* ---- 1) Gerente → Gerente Geral (somente cargo canônico exato) ---- */
  UPDATE f
  SET Cargo = N'Gerente Geral'
  FROM dbo.Funcionarios f
  WHERE f.Ativos = 1
    AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Gerente';

  /* ---- 2) Gerente Administrativo ---- */
  ;WITH gadm AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Gerente Administrativo'
  )
  UPDATE f
  SET Cargo = N'Supervisor Administrativo'
  FROM dbo.Funcionarios f
  INNER JOIN gadm g ON g.FuncionarioId = f.FuncionarioId
  WHERE g.rn > @MaxGerenteAdministrativo;

  /* ---- 3) Gerente de Operações ---- */
  ;WITH gop AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Gerente de Operações'
  )
  UPDATE f
  SET Cargo = N'Supervisor de Operações'
  FROM dbo.Funcionarios f
  INNER JOIN gop g ON g.FuncionarioId = f.FuncionarioId
  WHERE g.rn > @MaxGerenteOperacoes;

  /* ---- 4) Coordenador Administrativo ---- */
  ;WITH cadm AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Coordenador Administrativo'
  )
  UPDATE f
  SET Cargo = N'Analista Administrativo'
  FROM dbo.Funcionarios f
  INNER JOIN cadm g ON g.FuncionarioId = f.FuncionarioId
  WHERE g.rn > @MaxCoordenadorAdministrativo;

  /* ---- 5) Coordenador Geral → 6 tipos + Supervisor ---- */
  ;WITH cg AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Coordenador Geral'
  ),
  map AS (
    SELECT
      FuncionarioId,
      rn,
      ((rn - 1) % 6) + 1 AS role_ix,
      ((rn - 1) / 6) + 1 AS round_num
    FROM cg
  )
  UPDATE f
  SET
    Cargo = CASE
      WHEN m.round_num > @MaxRodadasCoordenadorGeral THEN N'Supervisor Operacional'
      WHEN m.role_ix = 1 THEN N'Coordenador de TI'
      WHEN m.role_ix = 2 THEN N'Coordenador Segurança'
      WHEN m.role_ix = 3 THEN N'Coordenador de Operações'
      WHEN m.role_ix = 4 THEN N'Coordenador de Manutenção'
      WHEN m.role_ix = 5 THEN N'Coordenador de Atendimento'
      WHEN m.role_ix = 6 THEN N'Coordenador de Alimentos'
      ELSE N'Supervisor Operacional'
    END
  FROM dbo.Funcionarios f
  INNER JOIN map m ON m.FuncionarioId = f.FuncionarioId;

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

/* Relatório pós-migração */
SELECT Cargo COLLATE Latin1_General_CI_AI AS Cargo, COUNT(*) AS Qtd
FROM dbo.Funcionarios
WHERE Ativos = 1
  AND Cargo IS NOT NULL
  AND LTRIM(RTRIM(Cargo)) <> N''
GROUP BY Cargo COLLATE Latin1_General_CI_AI
ORDER BY Cargo;
