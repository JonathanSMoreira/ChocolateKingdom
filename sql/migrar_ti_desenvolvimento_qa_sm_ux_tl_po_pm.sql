/*
  Migração — área TI (Setor): redistribui Desenvolvedor(es), remove Suporte TI para Analista de Sistema,
  preenche cotas de cargos QA, SM, UX/UI, TL, PO, PM; excedente → Analista de Sistema.

  Cotas (por ordem crescente de FuncionarioId entre quem ainda está como Desenvolvedor no setor TI):
    QA (Analista QA)     : 10
    SM (Scrum Master)    : 4
    UX/UI                : 4
    TL (Tech Lead)       : 4
    PO (Product Owner)   : 4
    PM (Product Manager) : 2
    --- total 28 vagas “especializadas”; demais desenvolvedores → Analista de Sistema

  1) Todo cargo Suporte TI (no setor TI) → Analista de Sistema.
  2) Desenvolvedor*: LINHA(%desenvolv%) no setor TI → distribuição acima; restante → Analista de Sistema.

  Setores considerados “área TI”: TI, Tecnologia da Informação (ajuste a lista @SetoresTI se precisar).

  IMPORTANTE: backup antes; teste em cópia do banco.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  /* ---- 0) Ajuste aqui se seus setores forem outros nomes ---- */
  DECLARE @SetoresTI TABLE (Nome NVARCHAR(80) COLLATE Latin1_General_CI_AI PRIMARY KEY);
  INSERT INTO @SetoresTI (Nome) VALUES (N'TI'), (N'Tecnologia da Informação');

  /* ---- 1) Suporte TI → Analista de Sistema ---- */
  UPDATE f
  SET Cargo = N'Analista de Sistema'
  FROM dbo.Funcionarios f
  WHERE f.Ativos = 1
    AND EXISTS (
      SELECT 1 FROM @SetoresTI s
      WHERE LTRIM(RTRIM(f.Setor)) COLLATE Latin1_General_CI_AI = s.Nome
    )
    AND (
      LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Suporte TI'
      OR LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Suporte T.I.'
    );

  /* ---- 2) Desenvolvedor(es) no TI: round-robin em blocos de cotas ---- */
  ;WITH alvo AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND EXISTS (
        SELECT 1 FROM @SetoresTI s
        WHERE LTRIM(RTRIM(f.Setor)) COLLATE Latin1_General_CI_AI = s.Nome
      )
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI LIKE N'%desenvolv%'
  ),
  mapa AS (
    SELECT
      FuncionarioId,
      rn,
      CASE
        WHEN rn <= 10 THEN N'Analista QA'
        WHEN rn <= 14 THEN N'Scrum Master'
        WHEN rn <= 18 THEN N'UX/UI'
        WHEN rn <= 22 THEN N'Tech Lead'
        WHEN rn <= 26 THEN N'Product Owner'
        WHEN rn <= 28 THEN N'Product Manager'
        ELSE N'Analista de Sistema'
      END AS NovoCargo
    FROM alvo
  )
  UPDATE f
  SET Cargo = m.NovoCargo
  FROM dbo.Funcionarios f
  INNER JOIN mapa m ON m.FuncionarioId = f.FuncionarioId;

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

/* Conferência: TI por cargo */
SELECT
  LTRIM(RTRIM(f.Setor)) AS Setor,
  LTRIM(RTRIM(f.Cargo)) AS Cargo,
  COUNT(*) AS Qtd
FROM dbo.Funcionarios f
WHERE f.Ativos = 1
  AND EXISTS (
    SELECT 1 FROM (VALUES (N'TI'), (N'Tecnologia da Informação')) AS s(Nome)
    WHERE LTRIM(RTRIM(f.Setor)) COLLATE Latin1_General_CI_AI = s.Nome
  )
GROUP BY LTRIM(RTRIM(f.Setor)) COLLATE Latin1_General_CI_AI, LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI
ORDER BY Setor, Cargo;
