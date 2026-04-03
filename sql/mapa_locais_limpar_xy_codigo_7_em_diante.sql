-- Zera X e Y (e reduz Largura/Altura ao mínimo permitido pelas CHECKs) para linhas com
-- Codigo numérico inteiro >= 7. Não altera códigos alfanuméricos (ex.: bi-atr-*).
-- O app não desenha pin para esses códigos (só 1–6 + slugs demo); a legenda lista todos.

USE CacauParque;
GO

UPDATE dbo.MapaLocais
SET
  X = 0,
  Y = 0,
  Largura = 0.000001,
  Altura = 0.000001,
  AtualizadoEm = SYSDATETIME()
WHERE TRY_CONVERT(INT, LTRIM(RTRIM(Codigo))) >= 7;
GO
