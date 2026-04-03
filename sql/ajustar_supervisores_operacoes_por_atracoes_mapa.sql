/*
  Alinha a quantidade de "Supervisor de Operações" em dbo.Funcionarios com a quantidade
  de atrações cadastradas no mapa (dbo.MapaLocais.Tipo = atracao, case-insensitive),
  por parque (default: Codigo = N'cacau-parque'). Somente registros com Ativos = 1.

  Regras:
  - Excesso de supervisores: mantém os N menores FuncionarioId como "Supervisor de Operações";
    os demais passam a "Encarregado de Atração" (Setor permanece como está).
  - Falta: promove até o necessário a partir de "Encarregado de Atração" (menor FuncionarioId),
    priorizando quem já está no setor "Operações" (case-insensitive).

  Pré-requisitos:
  - Rodar após dados em MapaLocais e (opcional) migrar_cargos_gerentes_coordenadores.sql.
  - Se não existir pessoal "Encarregado de Atração" suficiente, o script só promove o que
    houver e o SELECT final mostra o déficit.

  Inspeção só leitura (quantidade de atrações no mapa):
    SELECT COUNT(*) AS QtdAtracoes
    FROM dbo.MapaLocais ml
    INNER JOIN dbo.Parques p ON p.Id = ml.ParqueId
    WHERE p.Codigo = N'cacau-parque'
      AND ml.Ativo = 1
      AND LTRIM(RTRIM(ml.Tipo)) COLLATE Latin1_General_CI_AI = N'atracao';
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ParqueCodigo NVARCHAR(50) = N'cacau-parque';

DECLARE @QtdAtracoes INT;

SELECT @QtdAtracoes = COUNT_BIG(*)
FROM dbo.MapaLocais ml
INNER JOIN dbo.Parques p ON p.Id = ml.ParqueId
WHERE p.Codigo = @ParqueCodigo
  AND ml.Ativo = 1
  AND LTRIM(RTRIM(ml.Tipo)) COLLATE Latin1_General_CI_AI = N'atracao';

IF @QtdAtracoes IS NULL
  SET @QtdAtracoes = 0;

BEGIN TRY
  BEGIN TRAN;

  /* Demover excedente de supervisores */
  ;WITH sup AS (
    SELECT
      f.FuncionarioId,
      ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de Operações'
  )
  UPDATE f
  SET Cargo = N'Encarregado de Atração'
  FROM dbo.Funcionarios f
  INNER JOIN sup s ON s.FuncionarioId = f.FuncionarioId
  WHERE s.rn > @QtdAtracoes;

  DECLARE @AtualSup INT = (
    SELECT COUNT(*)
    FROM dbo.Funcionarios f
    WHERE f.Ativos = 1
      AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de Operações'
  );

  DECLARE @Falta INT = @QtdAtracoes - @AtualSup;

  IF @Falta > 0
  BEGIN
    ;WITH cand AS (
      SELECT
        f.FuncionarioId,
        ROW_NUMBER() OVER (
          ORDER BY
            CASE
              WHEN LTRIM(RTRIM(ISNULL(f.Setor, N''))) COLLATE Latin1_General_CI_AI = N'Operações'
              THEN 0
              ELSE 1
            END,
            f.FuncionarioId
        ) AS rn
      FROM dbo.Funcionarios f
      WHERE f.Ativos = 1
        AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Encarregado de Atração'
    )
    UPDATE f
    SET Cargo = N'Supervisor de Operações'
    FROM dbo.Funcionarios f
    INNER JOIN cand c ON c.FuncionarioId = f.FuncionarioId
    WHERE c.rn <= @Falta;
  END;

  COMMIT TRAN;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRAN;
  THROW;
END CATCH;

/* Resumo */
DECLARE @SupFinal INT = (
  SELECT COUNT(*)
  FROM dbo.Funcionarios f
  WHERE f.Ativos = 1
    AND LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor de Operações'
);

SELECT
  @ParqueCodigo AS ParqueCodigo,
  @QtdAtracoes AS QtdAtracoesMapa,
  @SupFinal AS SupervisoresOperacoes,
  @QtdAtracoes - @SupFinal AS DeficitSupervisor;
