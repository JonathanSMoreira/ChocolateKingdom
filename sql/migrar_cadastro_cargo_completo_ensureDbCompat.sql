/*
  =============================================================================
  CadastroCargo + Funcionarios — espelho do ensureDbCompat (server.js), revisão 2026
  =============================================================================

  Ajuste USE [CacauParque] para o banco do seu .env (DB_NAME).

  Conteúdo alinhado ao backend atual:
  • Renomeações: coord. atendimento/alimentos, Analista, Assistente, Gerente, Coord. Geral
  • Retiradas de catálogo + migração: Supervisor, Encarregado, Líder, Auxiliar, Assistente de Operações
  • Seed de cargos que faltam (como o MERGE do Node)
  • Normalização "Lider" sem acento → Líder de Alimentos (Funcionarios + CadastroCargo)

  OrdemExibicao: valor menor = cargo mais alto na lista (ORDER BY OrdemExibicao).
  Coordenadores antes dos supervisores; líderes após supervisores; Mecânico antes do Auxiliar.

  Execute o script inteiro uma vez (F5). Idempotente na maior parte (reexecutar INSERTs ignora duplicatas).
  =============================================================================
*/

SET NOCOUNT ON;
USE [CacauParque];
GO

IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NULL
   OR OBJECT_ID('dbo.Funcionarios', 'U') IS NULL
BEGIN
  RAISERROR('Tabelas dbo.CadastroCargo e/ou dbo.Funcionarios não encontradas.', 16, 1);
  RETURN;
END;
GO

BEGIN TRANSACTION;

BEGIN TRY

  /* ---------- 1) Funcionarios: renomeações em lote ---------- */
  UPDATE f SET f.Cargo = v.novo
  FROM dbo.Funcionarios f
  INNER JOIN (VALUES
    (N'Coordenador de Atendimento', N'Supervisor de Atendimento'),
    (N'Coordenador de Alimentos', N'Supervisor de Alimentos'),
    (N'Analista', N'Analista de TI'),
    (N'Assistente', N'Assistente Administrativo')
  ) AS v(antigo, novo)
    ON LTRIM(RTRIM(f.Cargo)) COLLATE Latin1_General_CI_AI = v.antigo COLLATE Latin1_General_CI_AI;

  UPDATE dbo.Funcionarios
  SET Cargo = N'Gerente de Operações'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Gerente';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Coordenador Administrativo'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Coordenador Geral';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Supervisor Operacional'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Supervisor';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Supervisor Operacional'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Encarregado';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Líder de Alimentos'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Líder';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Auxiliar de Operações'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Auxiliar';

  UPDATE dbo.Funcionarios
  SET Cargo = N'Assistente Administrativo'
  WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Assistente de Operações';

  /* ---------- 2) CadastroCargo: renomear linhas legadas (evita duplicar nome) ---------- */
  IF NOT EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Supervisor de Atendimento'
  )
    UPDATE dbo.CadastroCargo
    SET Nome = N'Supervisor de Atendimento', OrdemExibicao = 110
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Coordenador de Atendimento';

  IF NOT EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Supervisor de Alimentos'
  )
    UPDATE dbo.CadastroCargo
    SET Nome = N'Supervisor de Alimentos', OrdemExibicao = 120
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Coordenador de Alimentos';

  IF NOT EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Analista de TI'
  )
    UPDATE dbo.CadastroCargo
    SET Nome = N'Analista de TI', OrdemExibicao = 180
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Analista';

  IF NOT EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Assistente Administrativo'
  )
    UPDATE dbo.CadastroCargo
    SET Nome = N'Assistente Administrativo', OrdemExibicao = 190
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Assistente';

  /* ---------- 3) CadastroCargo: remover nomes retirados / órfãos ---------- */
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Coordenador de Atendimento';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Coordenador de Alimentos';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Analista'
    AND NOT EXISTS (
      SELECT 1 FROM dbo.Funcionarios
      WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Analista'
    );
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Assistente'
    AND NOT EXISTS (
      SELECT 1 FROM dbo.Funcionarios
      WHERE LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'Assistente'
    );

  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Gerente';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Coordenador Geral';

  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Supervisor';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Encarregado';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Líder';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Auxiliar';
  DELETE FROM dbo.CadastroCargo
  WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CI_AI = N'Assistente de Operações';

  /* ---------- 4) Seed (insere se faltar) — nomes alinhados ao MERGE do server.js ---------- */
  INSERT INTO dbo.CadastroCargo (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
  SELECT s.Nome, 1, 1, s.OrdemExibicao, s.Setor
  FROM (VALUES
    (N'Gerente Geral', 10, N'Administrativo'),
    (N'Gerente Administrativo', 20, N'Administrativo'),
    (N'Gerente de Tecnologia', 26, N'TI'),
    (N'Gerente de Manutenção', 28, N'Manutenção'),
    (N'Gerente de Operações', 30, N'Operações'),
    (N'Coordenador Administrativo', 40, N'Administrativo'),
    (N'Coordenador de TI', 42, N'TI'),
    (N'Coordenador Segurança', 44, N'Segurança'),
    (N'Coordenador de Operações', 46, N'Operações'),
    (N'Coordenador de Manutenção', 48, N'Manutenção'),
    (N'Supervisor Administrativo', 60, N'Administrativo'),
    (N'Supervisor de Operações', 62, N'Operações'),
    (N'Supervisor de Atendimento', 64, N'Atendimento'),
    (N'Supervisor de Alimentos', 66, N'Alimentos'),
    (N'Supervisor Operacional', 68, N'Operações'),
    (N'Líder de Alimentos', 80, N'Alimentos'),
    (N'Líder de Cozinha', 90, N'Alimentos'),
    (N'Analista Administrativo', 150, N'Administrativo'),
    (N'Analista de TI', 155, N'TI'),
    (N'Assistente Administrativo', 170, N'Administrativo'),
    (N'Assistente de TI', 175, N'TI'),
    (N'Mecânico', 185, N'Manutenção'),
    (N'Auxiliar de Operações', 200, N'Operações')
  ) AS s(Nome, OrdemExibicao, Setor)
  WHERE NOT EXISTS (
    SELECT 1 FROM dbo.CadastroCargo c
    WHERE LTRIM(RTRIM(c.Nome)) COLLATE Latin1_General_CI_AI = s.Nome COLLATE Latin1_General_CI_AI
  );

  /* ---------- 4b) Sincroniza OrdemExibicao e Setor em cargos já existentes ---------- */
  UPDATE c SET
    c.OrdemExibicao = v.OrdemExibicao,
    c.Setor = v.Setor
  FROM dbo.CadastroCargo c
  INNER JOIN (VALUES
    (N'Gerente Geral', 10, N'Administrativo'),
    (N'Gerente Administrativo', 20, N'Administrativo'),
    (N'Gerente de Tecnologia', 26, N'TI'),
    (N'Gerente de Manutenção', 28, N'Manutenção'),
    (N'Gerente de Operações', 30, N'Operações'),
    (N'Coordenador Administrativo', 40, N'Administrativo'),
    (N'Coordenador de TI', 42, N'TI'),
    (N'Coordenador Segurança', 44, N'Segurança'),
    (N'Coordenador de Operações', 46, N'Operações'),
    (N'Coordenador de Manutenção', 48, N'Manutenção'),
    (N'Supervisor Administrativo', 60, N'Administrativo'),
    (N'Supervisor de Operações', 62, N'Operações'),
    (N'Supervisor de Atendimento', 64, N'Atendimento'),
    (N'Supervisor de Alimentos', 66, N'Alimentos'),
    (N'Supervisor Operacional', 68, N'Operações'),
    (N'Líder de Alimentos', 80, N'Alimentos'),
    (N'Líder de Cozinha', 90, N'Alimentos'),
    (N'Analista Administrativo', 150, N'Administrativo'),
    (N'Analista de TI', 155, N'TI'),
    (N'Assistente Administrativo', 170, N'Administrativo'),
    (N'Assistente de TI', 175, N'TI'),
    (N'Mecânico', 185, N'Manutenção'),
    (N'Auxiliar de Operações', 200, N'Operações')
  ) AS v(Nome, OrdemExibicao, Setor)
    ON LTRIM(RTRIM(c.Nome)) COLLATE Latin1_General_CI_AI = v.Nome COLLATE Latin1_General_CI_AI;

  /* ---------- 5) "Lider" ASCII no cadastro e em Funcionarios ---------- */
  UPDATE dbo.Funcionarios
  SET Cargo = N'Líder de Alimentos'
  WHERE Cargo IS NOT NULL
    AND LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = N'lider'
    AND Cargo NOT LIKE N'%í%'
    AND Cargo NOT LIKE N'%Í%';

  IF EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Líder de Alimentos'
  )
    DELETE FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider';
  ELSE IF EXISTS (
    SELECT 1 FROM dbo.CadastroCargo
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider'
  )
    UPDATE dbo.CadastroCargo
    SET Nome = N'Líder de Alimentos'
    WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider';

  COMMIT TRANSACTION;
  PRINT N'cadastro_cargo_completo_ensureDbCompat: concluído (COMMIT).';
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  DECLARE @msg NVARCHAR(4000) = ERROR_MESSAGE();
  RAISERROR(N'Erro: %s', 16, 1, @msg);
END CATCH;
GO
