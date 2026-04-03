/*
  Padronização e redução de quadro (bilheteria / atendimento).

  1) Cargo exatamente "Auxiliar" (trim, case-insensitive) → "Auxiliar de atendimento".
  2) "Bilheteria" + "caixa" no mesmo cargo (e variantes sem "supervisor"/"coordenador"/"gerente")
     → "Atendente" (equivalente a atendente de bilheteria/caixa).
  3) "Supervisor de bilheteria": mantém @ManterSupBilheteria pessoas (menores FuncionarioId);
     demais registros — EXCLUSÃO de dbo.Clientes (CASCADE: Funcionarios, Enderecos, AuthExterno quando houver).
  4) "Supervisor de atendimento": mantém @ManterSupAtendimento; demais — mesma exclusão.
  5) Cargo "Atendente" (CI): EXCLUSÃO de todos os dbo.Clientes vinculados a esses Funcionarios.

  Parâmetros no topo: ajuste se necessário.

  ATENÇÃO: exclusão é permanente. Faça backup. Rode primeiro o bloco comentado de pré-visualização
  em cópia do banco se possível.

  Compatível com FKs usuais do projeto (Enderecos e AuthExterno com ON DELETE CASCADE para Clientes).
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ManterSupBilheteria INT = 5;
DECLARE @ManterSupAtendimento INT = 10;

BEGIN TRY
  BEGIN TRAN;

  /* 1) Auxiliar isolado → Auxiliar de atendimento */
  UPDATE dbo.Funcionarios
  SET Cargo = N'Auxiliar de atendimento'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Auxiliar';

  /* 2) Bilheteria + caixa → Atendente (não promove líderes) */
  UPDATE f
  SET Cargo = N'Atendente'
  FROM dbo.Funcionarios f
  WHERE f.Cargo IS NOT NULL
    AND f.Cargo COLLATE Latin1_General_CI_AI NOT LIKE N'%supervisor%'
    AND f.Cargo COLLATE Latin1_General_CI_AI NOT LIKE N'%coordenad%'
    AND f.Cargo COLLATE Latin1_General_CI_AI NOT LIKE N'%gerente%'
    AND (
      (
        f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%bilheteria%'
        AND f.Cargo COLLATE Latin1_General_CI_AI LIKE N'%caixa%'
      )
      OR LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI IN (
        N'Bilheteria caixa',
        N'Caixa bilheteria',
        N'Caixa da bilheteria',
        N'Atendente de bilheteria',
        N'Atendente bilheteria'
      )
    );

  /* 3) Supervisor de bilheteria — excedente removido do cadastro */
  ;WITH supb AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de bilheteria'
  )
  DELETE c
  FROM dbo.Clientes c
  INNER JOIN supb s ON s.FuncionarioId = c.Id
  WHERE s.rn > @ManterSupBilheteria;

  /* 4) Supervisor de atendimento — excedente removido */
  ;WITH supa AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de atendimento'
  )
  DELETE c
  FROM dbo.Clientes c
  INNER JOIN supa s ON s.FuncionarioId = c.Id
  WHERE s.rn > @ManterSupAtendimento;

  /* 5) Todos com cargo Atendente — remoção do cadastro */
  DELETE c
  FROM dbo.Clientes c
  INNER JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
  WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Atendente';

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

/* Conferência rápida */
SELECT N'Supervisor de bilheteria' AS Cargo, COUNT(*) AS Qtd
FROM dbo.Funcionarios f
WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de bilheteria'
UNION ALL
SELECT N'Supervisor de atendimento', COUNT(*)
FROM dbo.Funcionarios f
WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de atendimento'
UNION ALL
SELECT N'Atendente', COUNT(*)
FROM dbo.Funcionarios f
WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Atendente'
UNION ALL
SELECT N'Auxiliar de atendimento', COUNT(*)
FROM dbo.Funcionarios f
WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Auxiliar de atendimento';

/*
-- Pré-visualização (rode em cópia; não delete)
DECLARE @ManterSupBilheteria INT = 5;
DECLARE @ManterSupAtendimento INT = 10;

;WITH supb AS (
  SELECT f.FuncionarioId, f.Cargo, ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
  FROM dbo.Funcionarios f
  WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de bilheteria'
)
SELECT 'DELETE sup bilheteria' AS Acao, FuncionarioId, Cargo, rn FROM supb WHERE rn > @ManterSupBilheteria;

;WITH supa AS (
  SELECT f.FuncionarioId, f.Cargo, ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
  FROM dbo.Funcionarios f
  WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de atendimento'
)
SELECT 'DELETE sup atendimento' AS Acao, FuncionarioId, Cargo, rn FROM supa WHERE rn > @ManterSupAtendimento;

SELECT 'DELETE atendente' AS Acao, f.FuncionarioId, f.Cargo
FROM dbo.Funcionarios f
WHERE LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Atendente';
*/
