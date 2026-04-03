/*
  Catálogo de cargos / funções (dbo.CadastroCargo).

  A tabela e o seed inicial dos cargos padrão são criados/atualizados pelo backend
  (ensureDbCompat em server.js).

  Colunas principais:
    - Nome (único)
    - Descricao (opcional)
    - Setor (obrigatório em novos cadastros via API; cargos seed podem ter NULL)
    - Nivel (opcional)
    - PadraoSistema: 1 = seed do sistema; 0 = inclusão via app
    - OrdemExibicao: ordenação

  API:
    GET  /api/funcionarios/:id/cadastro-cargos
    POST /api/funcionarios/:id/cadastro-cargos
         { "nome", "setor", "subordinadoACargoId", "nivel?", "descricao?" }
         subordinadoACargoId = Id de um cargo existente com OrdemExibicao; o novo cargo
         recebe OrdemExibicao = ref+1 e os demais com ordem > ref são incrementados.
*/

USE CacauParque;
GO

IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NULL
BEGIN
  RAISERROR('Execute o backend uma vez (ensureDbCompat) ou crie a tabela conforme server.js.', 16, 1);
END
ELSE
  SELECT COUNT(*) AS TotalCargos FROM dbo.CadastroCargo WHERE Ativo = 1;
GO
