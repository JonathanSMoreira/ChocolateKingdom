@echo off
chcp 65001 >nul
echo Verificando ultimos cadastros em CacauParque.dbo.Clientes...
echo Servidor: JONATHANMOREIRA (Windows Auth). Ajuste -S se o seu for outro.
echo.

sqlcmd -S JONATHANMOREIRA -d CacauParque -E -Q "SET NOCOUNT ON; SELECT TOP 15 Id, Nome, Email, DataNascimento, Telefone, Documento, CriadoEm, AtualizadoEm FROM dbo.Clientes ORDER BY Id DESC;"

if errorlevel 1 (
  echo.
  echo Se deu erro "sqlcmd nao reconhecido", instale as ferramentas de linha de comando do SQL Server
  echo ou abra o SSMS e execute a mesma SELECT numa nova consulta.
)
echo.
pause
