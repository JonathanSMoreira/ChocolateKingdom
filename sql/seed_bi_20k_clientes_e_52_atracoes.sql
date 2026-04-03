/*
  Dados sintéticos para BI / testes de volume (remover antes de produção).

  Parte A: 20.000 clientes fictícios + endereço por cliente.
    - E-mail: bi_fake_<n>@seed.local (único; domínio .local evita envio real)
    - Senha (todas iguais): BiSeed#1a
    - Hash bcrypt ($2b$12$...): gerado com bcryptjs cost 12

  Parte B: 52 atrações em dbo.MapaLocais (Parque cacau-parque), categoria Diversão.

  Uso: SSMS / sqlcmd contra o banco CacauParque (ou o DB do seu .env).

  Depois deste script, rode migrate_clientes_funcionario_enderecos_reais.sql para:
    endereços com CEP/ruas reais (Brasil + exterior), coluna Funcionario, tabela Funcionarios
    e até 1000 funcionários entre os seeds brasileiros.

  Remover depois (ordem por FK):
    DELETE e FROM dbo.Enderecos e
      INNER JOIN dbo.Clientes c ON c.Id = e.ClienteId
      WHERE c.Email LIKE N'bi_fake_%@seed.local';
    DELETE FROM dbo.Clientes WHERE Email LIKE N'bi_fake_%@seed.local';
    DELETE FROM dbo.MapaLocais WHERE Codigo LIKE N'bi-atr-%';
    DELETE f FROM dbo.Funcionarios f INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId WHERE c.Email LIKE N'bi_fake_%@seed.local';
*/

USE CacauParque;
GO

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ---------- Parte A: clientes + endereços ---------- */

DECLARE @SenhaHash NVARCHAR(255) =
  N'$2b$12$tY3pWZujpHuxMKUa9wyp3.DpdQnDACpkPUptbjDnpsfjrFK9LjJbG';

BEGIN TRAN;

;WITH nums AS (
  SELECT TOP (20000)
    ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects o1
  CROSS JOIN sys.all_objects o2
),
nom AS (
  SELECT * FROM (VALUES
    (0,N'Ana'),(1,N'Bruno'),(2,N'Carla'),(3,N'Daniel'),(4,N'Elisa'),(5,N'Felipe'),(6,N'Gabriela'),(7,N'Henrique'),
    (8,N'Isabela'),(9,N'João'),(10,N'Karina'),(11,N'Lucas'),(12,N'Mariana'),(13,N'Nicolas'),(14,N'Olivia'),(15,N'Paulo'),
    (16,N'Raquel'),(17,N'Sergio'),(18,N'Talita'),(19,N'Ulisses'),(20,N'Vanessa'),(21,N'William'),(22,N'Yasmin'),(23,N'Zeca'),
    (24,N'Amanda'),(25,N'Bernardo'),(26,N'Camila'),(27,N'Diego'),(28,N'Fernanda'),(29,N'Gustavo'),(30,N'Helena'),(31,N'Igor'),
    (32,N'Juliana'),(33,N'Kleber'),(34,N'Larissa'),(35,N'Marcelo'),(36,N'Natália'),(37,N'Otávio'),(38,N'Patrícia'),(39,N'Rafael'),
    (40,N'Sabrina'),(41,N'Thiago'),(42,N'Úrsula'),(43,N'Vinícius'),(44,N'Wagner'),(45,N'Xavier'),(46,N'Yuri'),(47,N'Zilda'),
    (48,N'Alice'),(49,N'Bárbara'),(50,N'Caio'),(51,N'Davi'),(52,N'Eduarda'),(53,N'Fabio'),(54,N'Graziele'),(55,N'Hugo'),
    (56,N'Ingrid'),(57,N'Jorge'),(58,N'Kelly'),(59,N'Leandro'),(60,N'Mirella'),(61,N'Nelson'),(62,N'Priscila'),(63,N'Rodrigo')
  ) AS t(id, txt)
),
sob AS (
  SELECT * FROM (VALUES
    (0,N'Silva'),(1,N'Santos'),(2,N'Oliveira'),(3,N'Souza'),(4,N'Rodrigues'),(5,N'Ferreira'),(6,N'Alves'),(7,N'Pereira'),
    (8,N'Lima'),(9,N'Gomes'),(10,N'Ribeiro'),(11,N'Carvalho'),(12,N'Almeida'),(13,N'Lopes'),(14,N'Martins'),(15,N'Rocha'),
    (16,N'Costa'),(17,N'Araújo'),(18,N'Dias'),(19,N'Melo'),(20,N'Barbosa'),(21,N'Cardoso'),(22,N'Teixeira'),(23,N'Correia'),
    (24,N'Mendes'),(25,N'Nunes'),(26,N'Moreira'),(27,N'Álvares'),(28,N'Monteiro'),(29,N'Moura'),(30,N'Freitas'),(31,N'Vieira'),
    (32,N'Ramos'),(33,N'Nascimento'),(34,N'Machado'),(35,N'Andrade'),(36,N'Castro'),(37,N'Campos'),(38,N'Reis'),(39,N'Duarte'),
    (40,N'Peixoto'),(41,N'Farias'),(42,N'Barros'),(43,N'Pinto'),(44,N'Xavier'),(45,N'Batista'),(46,N'Miranda'),(47,N'Paiva'),
    (48,N'Fonseca'),(49,N'Azevedo'),(50,N'Tavares'),(51,N'Guimarães'),(52,N'Henriques'),(53,N'Cavalcanti'),(54,N'Borges'),
    (55,N'Pinheiro'),(56,N'Sales'),(57,N'Coelho'),(58,N'Vasconcelos'),(59,N'Toledo'),(60,N'Aguiar'),(61,N'Bezerra'),(62,N'Cunha'),
    (63,N'Dantas'),(64,N'Escobar'),(65,N'Fraga'),(66,N'Guedes'),(67,N'Horta'),(68,N'Izidoro'),(69,N'Jardim'),(70,N'Knupp'),
    (71,N'Leite'),(72,N'Maia')
  ) AS t(id, txt)
)
INSERT INTO dbo.Clientes (
  Nome, Sobrenome, Apelido, Email, SenhaHash, DataNascimento, Telefone, Documento, Ativo
)
SELECT
  (SELECT nom.txt FROM nom WHERE nom.id = (nums.n - 1) % 64),
  (SELECT sob.txt FROM sob WHERE sob.id = (nums.n * 7 + 3) % 73),
  (SELECT nom.txt FROM nom WHERE nom.id = (nums.n * 13 + 5) % 64),
  CONCAT(N'bi_fake_', nums.n, N'@seed.local'),
  @SenhaHash,
  DATEADD(DAY, -(nums.n % 17000), CAST(N'2005-06-15' AS DATE)),
  CONCAT(
    N'(11)9',
    RIGHT(CONCAT(N'00000000', (nums.n * 7919) % 100000000), 8)
  ),
  NULL,
  1
FROM nums
WHERE NOT EXISTS (
  SELECT 1 FROM dbo.Clientes c2 WHERE c2.Email = CONCAT(N'bi_fake_', nums.n, N'@seed.local')
);

INSERT INTO dbo.Enderecos (ClienteId, Rua, Bairro, Pais, Cep, Numero)
SELECT
  c.Id,
  CONCAT(
    N'Rua ',
    (ABS(CHECKSUM(c.Email)) % 9000) + 1,
    N' ',
    CASE (c.Id % 6)
      WHEN 0 THEN N'Ipiranga'
      WHEN 1 THEN N'das Flores'
      WHEN 2 THEN N'Central'
      WHEN 3 THEN N'do Comércio'
      WHEN 4 THEN N'Boa Vista'
      ELSE N'São José'
    END
  ),
  CASE (c.Id % 5)
    WHEN 0 THEN N'Centro'
    WHEN 1 THEN N'Jardim Europa'
    WHEN 2 THEN N'Vila Nova'
    WHEN 3 THEN N'Parque Industrial'
    ELSE N'Morro Alto'
  END,
  N'Brasil',
  RIGHT(CONCAT(N'00000000', (c.Id * 13 + 10000) % 99999999), 8),
  CAST((c.Id * 7) % 3200 AS NVARCHAR(20))
FROM dbo.Clientes c
WHERE c.Email LIKE N'bi_fake_%@seed.local'
  AND NOT EXISTS (SELECT 1 FROM dbo.Enderecos e WHERE e.ClienteId = c.Id);

COMMIT TRAN;
GO

/* ---------- Parte B: 52 atrações (MapaLocais) ---------- */

DECLARE @ParqueId INT = (SELECT TOP 1 Id FROM dbo.Parques WHERE Codigo = N'cacau-parque');
IF @ParqueId IS NULL
BEGIN
  RAISERROR(N'Parque cacau-parque não encontrado. Rode mapa_locais_schema.sql antes.', 16, 1);
  RETURN;
END;

DECLARE @i INT = 1;
DECLARE @nome NVARCHAR(140);
DECLARE @codigo NVARCHAR(60);
DECLARE @gx INT;
DECLARE @gy INT;
DECLARE @x DECIMAL(9,6);
DECLARE @y DECIMAL(9,6);
DECLARE @lw DECIMAL(9,6) = 0.045000;
DECLARE @lh DECIMAL(9,6) = 0.038000;
DECLARE @fila INT;

WHILE @i <= 52
BEGIN
  SET @codigo = CONCAT(N'bi-atr-', RIGHT(CONCAT(N'00', CAST(@i AS VARCHAR(3))), 3));
  IF NOT EXISTS (SELECT 1 FROM dbo.MapaLocais WHERE ParqueId = @ParqueId AND Codigo = @codigo)
  BEGIN
    SET @gx = (@i - 1) % 8;
    SET @gy = (@i - 1) / 8;
    SET @x = 0.06 + @gx * 0.108;
    SET @y = 0.10 + @gy * 0.115;
    IF @x + @lw > 0.98 SET @x = 0.98 - @lw;
    IF @y + @lh > 0.95 SET @y = 0.95 - @lh;
    SET @fila = 8 + (@i * 17) % 55;

    SET @nome = CASE @i
      WHEN 1 THEN N'Montanha do Cacau Selvagem'
      WHEN 2 THEN N'Roda Gigante Brownie'
      WHEN 3 THEN N'Tobogã Trufa Veloz'
      WHEN 4 THEN N'Casa Assombrada do Chocolate Amargo'
      WHEN 5 THEN N'Carrossel Dourado'
      WHEN 6 THEN N'Navio Pirata do Cacau'
      WHEN 7 THEN N'Barca Viking Avelã'
      WHEN 8 THEN N'Samba Funghi (cogumelo doce)'
      WHEN 9 THEN N'Torre do Pão de Mel'
      WHEN 10 THEN N'Looping Nibs'
      WHEN 11 THEN N'Rafting River Crunch'
      WHEN 12 THEN N'Minas Inferno Crocante'
      WHEN 13 THEN N'Elevador Caramelo'
      WHEN 14 THEN N'Tirolesa Açúcar Mascavo'
      WHEN 15 THEN N'Labirinto Mágico do Cacau'
      WHEN 16 THEN N'Cine 7D Chocolate Quente'
      WHEN 17 THEN N'Playground Pettit Poá'
      WHEN 18 THEN N'Avião Spray Mentolado'
      WHEN 19 THEN N'Disko Whirl Trufa Branca'
      WHEN 20 THEN N'Castelo Drágeas'
      WHEN 21 THEN N'Fábula dos Ovos de Páscoa'
      WHEN 22 THEN N'Trem Panorama Lacta'
      WHEN 23 THEN N'Canoa Splash Ao Leite'
      WHEN 24 THEN N'Escorregador Cupuaçu'
      WHEN 25 THEN N'Ponte Suspensa Amêndoas'
      WHEN 26 THEN N'Observatório Dragee'
      WHEN 27 THEN N'Teatro Mágico do Bean-to-Bar'
      WHEN 28 THEN N'Pista Kart Cocoa GP'
      WHEN 29 THEN N'Simulador Fábrica 360°'
      WHEN 30 THEN N'Refúgio das Borboletas do Cacau'
      WHEN 31 THEN N'Jardim Sensorial do Chocolate'
      WHEN 32 THEN N'Picadeiro Show Amargo 70%'
      WHEN 33 THEN N'Fantoche Nozes do Brasil'
      WHEN 34 THEN N'Roda Panorâmica Ganache'
      WHEN 35 THEN N'Queda Livre Nibs Ruby'
      WHEN 36 THEN N'Umbanda River (rio lento)'
      WHEN 37 THEN N'Explorador Mine Chocolate'
      WHEN 38 THEN N'Torre Quesillo Goiabada'
      WHEN 39 THEN N'Cabana Conto de Brigadeiro'
      WHEN 40 THEN N'Ilha do Marshmallow'
      WHEN 41 THEN N'Campo Mini Golfe Cacau'
      WHEN 42 THEN N'Espinha Peixe Wafer'
      WHEN 43 THEN N'Bate-Bate Bombom'
      WHEN 44 THEN N'Pirulito Twister'
      WHEN 45 THEN N'Carrosel Marfim 36 Voltas'
      WHEN 46 THEN N'Refrescância Túnel Zero'
      WHEN 47 THEN N'Perua Panetto Funk'
      WHEN 48 THEN N'Sala VR Mix de Grãos'
      WHEN 49 THEN N'Kids Trufa Tunel'
      WHEN 50 THEN N'Arco Íris Açucarado'
      WHEN 51 THEN N'Patins Palácio Doce'
      ELSE N'Roda Solar Chocolate ao Leite'
    END;

    INSERT INTO dbo.MapaLocais (
      ParqueId, Codigo, Nome, Tipo, Descricao, X, Y, Largura, Altura, Ordem,
      Classificacao, AlturaMinCm, Categoria, Aberto, TempoFilaMin, ImagemUrl, IconeMapaUrl
    )
    VALUES (
      @ParqueId,
      @codigo,
      @nome,
      N'atracao',
      N'Atração temática (registro BI).',
      @x,
      @y,
      @lw,
      @lh,
      200 + @i,
      N'Livre',
      100 + (@i % 40),
      N'Diversão',
      1,
      @fila,
      N'https://images.unsplash.com/photo-1511381939415-c1c1c269d1fc?auto=format&fit=crop&w=1000&q=80',
      N'/map-icons/icon-diversao.png'
    );
  END

  SET @i += 1;
END;
GO

SELECT COUNT(*) AS ClientesSeed FROM dbo.Clientes WHERE Email LIKE N'bi_fake_%@seed.local';
SELECT COUNT(*) AS EnderecosSeed FROM dbo.Enderecos e INNER JOIN dbo.Clientes c ON c.Id = e.ClienteId WHERE c.Email LIKE N'bi_fake_%@seed.local';
SELECT COUNT(*) AS AtracoesBI FROM dbo.MapaLocais WHERE Codigo LIKE N'bi-atr-%';
GO
