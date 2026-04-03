/*
  Alinha dbo.MapaLocais com o filtro da API (apenas Codigo numérico 1 a 6 no mapa).

  1) Renomeia os 6 slugs do seed para '1'..'6' (índice único ParqueId+Codigo: rode só se não existir conflito).
  2) Desativa locais numéricos com código > 6 (ex.: inclusões recentes) para não voltarem ao mapa se alguém afrouxar o filtro.

  Execute no banco CacauParque (ou o que estiver em DB_NAME).
*/
SET NOCOUNT ON;

DECLARE @ParqueId INT =
  (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = N'cacau-parque' AND Ativo = 1);

IF @ParqueId IS NULL
BEGIN
  RAISERROR(N'Parque cacau-parque não encontrado.', 16, 1);
  RETURN;
END;

/* Renomear seed legado → 1..6 (ordem fixa do seed) */
UPDATE dbo.MapaLocais SET Codigo = N'1' WHERE ParqueId = @ParqueId AND Codigo = N'banheiro-topo';
UPDATE dbo.MapaLocais SET Codigo = N'2' WHERE ParqueId = @ParqueId AND Codigo = N'restaurante-direita';
UPDATE dbo.MapaLocais SET Codigo = N'3' WHERE ParqueId = @ParqueId AND Codigo = N'lanchonete-meio';
UPDATE dbo.MapaLocais SET Codigo = N'4' WHERE ParqueId = @ParqueId AND Codigo = N'montanha-russa-encantada';
UPDATE dbo.MapaLocais SET Codigo = N'5' WHERE ParqueId = @ParqueId AND Codigo = N'pkaleo';
UPDATE dbo.MapaLocais SET Codigo = N'6' WHERE ParqueId = @ParqueId AND Codigo = N'cacau-show';

/* Códigos numéricos 7 ou mais: some do mapa/ API (podem ficar inativos para não reativar por engano) */
UPDATE dbo.MapaLocais
SET Ativo = 0,
    AtualizadoEm = SYSDATETIME()
WHERE ParqueId = @ParqueId
  AND Ativo = 1
  AND TRY_CONVERT(INT, LTRIM(RTRIM(Codigo))) > 6;

SELECT Codigo, Nome, Ativo
FROM dbo.MapaLocais
WHERE ParqueId = @ParqueId
ORDER BY TRY_CONVERT(INT, LTRIM(RTRIM(Codigo))), Nome;
