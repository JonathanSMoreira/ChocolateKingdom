# Prints do fluxo (GitHub)

Para as capturas aparecerem na documentação **[FLUXO_APP_SIMPLES.md](../FLUXO_APP_SIMPLES.md)** no GitHub, coloque nesta pasta **7 ficheiros PNG** com estes nomes exactos:

| Ficheiro | Conteúdo sugerido |
|----------|-------------------|
| `01-login-perfil-visitante.png` | Ecrã de login (aba Perfil, visitante) |
| `02-configuracoes-funcionario.png` | Configurações do funcionário |
| `03-cadastro-cargos.png` | Cadastro de cargos |
| `04-mapa-legenda.png` | Mapa — legenda / lista de locais |
| `05-equipe-presenca.png` | Equipe e presença |
| `06-mapa-parque.png` | Mapa do parque (vista principal) |
| `07-perfil-visitante-logado.png` | Perfil do visitante após login |

**Atalho:** na raiz do projeto, execute (ajuste a pasta de origem se preciso):

```powershell
.\scripts\copiar-prints-fluxo.ps1 -Source "$env:USERPROFILE\Downloads\prints-choco"
```

Os ficheiros na pasta `Source` podem manter os nomes originais do telemóvel; o script tenta mapear por data/hora no nome, ou copie manualmente e renomeie para a tabela acima.
