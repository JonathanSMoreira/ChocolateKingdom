/*
  Legado: presença por dia estava em dbo.FuncionarioPresencaDia.
  Atual: o calendário usa situação derivada em dbo.PontoEletronicoDia:
  Falta='S' → 0; Folga='S' → omitido no mapa; qualquer horário (Entrada/saídas) → 1.
  Bases antigas podem ainda ter coluna PresencaDia; a API faz COALESCE(PresencaDia, derivado) na leitura.
  A migração e o DROP da tabela antiga são feitos ao subir o backend (server.js).
*/
