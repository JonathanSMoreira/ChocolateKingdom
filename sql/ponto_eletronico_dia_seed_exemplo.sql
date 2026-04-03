/*
  Exemplos em dbo.PontoEletronicoDia para testes (CacauParque).

  Cenários (mesmo dia de referência @DiaRef):
    1 — Jornada encerrada com almoço (entrada, saída almoço, volta, saída final).
    2 — Ainda em expediente após o almoço (sem saída final).
    3 — Saiu para o almoço e ainda não voltou (entrada + saída almoço; volta e saída NULL).
    4 — Apenas entrada registrada (resto NULL).
    5 — Jornada encerrada sem intervalo de almoço (um único trecho: entrada + saída expediente).
    6 — Sem registro neste dia (nenhuma linha em PontoEletronicoDia — o 6º funcionário da lista não recebe INSERT).

  Ajuste @DiaRef se quiser outro dia. Rode após existirem linhas em dbo.Funcionarios.
*/

USE CacauParque;
GO

DECLARE @DiaRef DATE = CAST(GETDATE() AS DATE);

IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NULL
BEGIN
  RAISERROR('Tabela dbo.PontoEletronicoDia não existe. Suba o backend ou rode sql/ponto_eletronico.sql.', 16, 1);
  RETURN;
END;

/* Remove exemplos anteriores do mesmo dia (reexecução limpa) — opcional: comente se quiser acumular. */
DELETE d
FROM dbo.PontoEletronicoDia AS d
WHERE d.Dia = @DiaRef
  AND d.FuncionarioId IN (
    SELECT f.FuncionarioId
    FROM (
      SELECT TOP 6 f2.FuncionarioId
      FROM dbo.Funcionarios AS f2
      INNER JOIN dbo.Clientes AS c ON c.Id = f2.FuncionarioId
      WHERE f2.Ativos = 1
        AND c.Ativo = 1
      ORDER BY f2.FuncionarioId
    ) AS f
  );

;WITH Seis AS (
  SELECT TOP 6
    f.FuncionarioId,
    ROW_NUMBER() OVER (ORDER BY f.FuncionarioId) AS rn
  FROM dbo.Funcionarios AS f
  INNER JOIN dbo.Clientes AS c ON c.Id = f.FuncionarioId
  WHERE f.Ativos = 1
    AND c.Ativo = 1
  ORDER BY f.FuncionarioId
)
SELECT
  FuncionarioId,
  rn
INTO #Pick
FROM Seis;

IF (SELECT COUNT(*) FROM #Pick) < 6
BEGIN
  RAISERROR('São necessários pelo menos 6 funcionários ativos para todos os cenários (incluindo o sem registro). Ajuste ou reduza cenários.', 16, 1);
  DROP TABLE #Pick;
  RETURN;
END;

DECLARE @id1 INT = (SELECT FuncionarioId FROM #Pick WHERE rn = 1);
DECLARE @id2 INT = (SELECT FuncionarioId FROM #Pick WHERE rn = 2);
DECLARE @id3 INT = (SELECT FuncionarioId FROM #Pick WHERE rn = 3);
DECLARE @id4 INT = (SELECT FuncionarioId FROM #Pick WHERE rn = 4);
DECLARE @id5 INT = (SELECT FuncionarioId FROM #Pick WHERE rn = 5);
/* id6 = sem linha em PontoEletronicoDia neste dia */

/* Horários no mesmo dia @DiaRef (ajuste se quiser) */
DECLARE @tEnt1 DATETIME2(0) = DATEADD(HOUR, 8, CAST(@DiaRef AS DATETIME2));
DECLARE @tSaiAlm1 DATETIME2(0) = DATEADD(HOUR, 12, CAST(@DiaRef AS DATETIME2));
DECLARE @tVol1 DATETIME2(0) = DATEADD(MINUTE, 13 * 60, CAST(@DiaRef AS DATETIME2)); /* 13:00 */
DECLARE @tSaiExp1 DATETIME2(0) = DATEADD(HOUR, 18, CAST(@DiaRef AS DATETIME2));

DECLARE @tEnt2 DATETIME2(0) = DATEADD(MINUTE, 8 * 60 + 5, CAST(@DiaRef AS DATETIME2));
DECLARE @tSaiAlm2 DATETIME2(0) = DATEADD(MINUTE, 12 * 60 + 30, CAST(@DiaRef AS DATETIME2)); /* 12:30 */
DECLARE @tVol2 DATETIME2(0) = DATEADD(HOUR, 14, CAST(@DiaRef AS DATETIME2));
/* saída final NULL — ainda trabalhando */

DECLARE @tEnt3 DATETIME2(0) = DATEADD(HOUR, 9, CAST(@DiaRef AS DATETIME2));
DECLARE @tSaiAlm3 DATETIME2(0) = DATEADD(HOUR, 12, CAST(@DiaRef AS DATETIME2));
/* volta e saída NULL — ainda no almoço */

DECLARE @tEnt4 DATETIME2(0) = DATEADD(HOUR, 7, DATEADD(MINUTE, 45, CAST(@DiaRef AS DATETIME2)));

DECLARE @tEnt5 DATETIME2(0) = DATEADD(HOUR, 6, CAST(@DiaRef AS DATETIME2));
DECLARE @tSaiExp5 DATETIME2(0) = DATEADD(HOUR, 15, DATEADD(MINUTE, 30, CAST(@DiaRef AS DATETIME2))); /* jornada curta sem almoço */

INSERT INTO dbo.PontoEletronicoDia (
  FuncionarioId,
  Dia,
  Falta,
  Atestado,
  Folga,
  Justificativa,
  EntradaEm,
  SaidaAlmocoEm,
  VoltaAlmocoEm,
  SaidaExpedienteEm
)
VALUES
  (@id1, @DiaRef, NULL, NULL, NULL, NULL, @tEnt1, @tSaiAlm1, @tVol1, @tSaiExp1),
  (@id2, @DiaRef, NULL, NULL, NULL, NULL, @tEnt2, @tSaiAlm2, @tVol2, NULL),
  (@id3, @DiaRef, NULL, NULL, NULL, NULL, @tEnt3, @tSaiAlm3, NULL, NULL),
  (@id4, @DiaRef, NULL, NULL, NULL, NULL, @tEnt4, NULL, NULL, NULL),
  (@id5, @DiaRef, NULL, NULL, NULL, NULL, @tEnt5, NULL, NULL, @tSaiExp5);

DROP TABLE #Pick;

PRINT N'PontoEletronicoDia: exemplos inseridos para o dia ' + CONVERT(NVARCHAR(10), @DiaRef, 23) + N'.';
PRINT N'Cenário 6 (sem registro): funcionário excluído propositalmente — ver TOP 6 na sua base.';
GO
