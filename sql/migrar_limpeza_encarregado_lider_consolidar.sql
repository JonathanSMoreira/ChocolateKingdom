/*
  Consolida cargos de liderança da limpeza em dbo.Funcionarios (Ativos = 1).

  Critério de seleção (igual ao trigger TR_Funcionarios_NivelPorCargo / migrate_funcionarios_*):
  - Cargo com encarregad% + limpeza%, ou
  - Cargo com (lider% ou líder%) + higieniz%

  Regras:
  - Unifica o cargo dos selecionados para um título só: "Encarregado de Limpeza".
  - Mantém os @MaxTitulares primeiros por FuncionarioId como "Encarregado de Limpeza".
  - Demais passam a "Auxiliar de Limpeza".

  Ajuste @MaxTitulares se precisar (default 10).

  IMPORTANTE: backup / teste em cópia do banco antes.

  Para inspecionar sem alterar, rode o SELECT comentado no final (antes do UPDATE).
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @MaxTitulares INT = 10;

BEGIN TRY
  BEGIN TRAN;

  ;WITH limpeza_lideranca AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND f.Cargo IS NOT NULL
      AND (
        (
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
      )
  )
  UPDATE f
  SET Cargo = CASE
    WHEN l.rn <= @MaxTitulares THEN N'Encarregado de Limpeza'
    ELSE N'Auxiliar de Limpeza'
  END
  FROM dbo.Funcionarios f
  INNER JOIN limpeza_lideranca l ON l.FuncionarioId = f.FuncionarioId;

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

/* Relatório */
SELECT
  LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI AS Cargo,
  COUNT(*) AS Qtd
FROM dbo.Funcionarios
WHERE Ativos = 1
  AND Cargo IS NOT NULL
  AND LTRIM(RTRIM(Cargo)) <> N''
  AND (
    Cargo COLLATE Latin1_General_CI_AI LIKE N'%limpeza%'
    OR Cargo COLLATE Latin1_General_CI_AI LIKE N'%higieniz%'
  )
GROUP BY LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI
ORDER BY Cargo;

/*
-- Pré-visualização (substitua @MaxTitulares no CASE se quiser o mesmo número)
;WITH limpeza_lideranca AS (
  SELECT
    f.FuncionarioId,
    f.Cargo AS CargoAtual,
    ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
  FROM dbo.Funcionarios f
  WHERE f.Ativos = 1
    AND f.Cargo IS NOT NULL
    AND (
      (
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
    )
)
SELECT
  FuncionarioId,
  CargoAtual,
  rn,
  CASE WHEN rn <= 10 THEN N'Encarregado de Limpeza' ELSE N'Auxiliar de Limpeza' END AS CargoNovo
FROM limpeza_lideranca
ORDER BY rn;
*/
