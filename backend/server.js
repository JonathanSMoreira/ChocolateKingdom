require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

const useWindowsAuth =
  process.env.DB_USE_WINDOWS_AUTH === 'true' || process.env.DB_USE_WINDOWS_AUTH === '1';
const sql = useWindowsAuth ? require('mssql/msnodesqlv8') : require('mssql');

const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_ANDROID_CLIENT_ID = process.env.GOOGLE_ANDROID_CLIENT_ID || '';

const app = express();
app.use(cors({ origin: true }));
// Upload de foto de perfil em base64 pode ultrapassar o limite padrão (100kb).
app.use(express.json({ limit: '25mb' }));
/** Ícones dos hotspots do mapa (PNG iguais aos do app); URLs gravadas em MapaLocais.IconeMapaUrl como /map-icons/... */
app.use('/map-icons', express.static(path.join(__dirname, 'public', 'map-icons')));

/**
 * Recordsets ODBC/msnodesqlv8 podem expor colunas em minúsculas (nome vs Nome).
 * Garante leitura do valor correto da tabela.
 */
function rsGet(row, pascalName) {
  if (row == null || typeof row !== 'object') return undefined;
  const camel = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
  const lower = pascalName.toLowerCase();
  const upper = pascalName.toUpperCase();
  for (const key of [pascalName, camel, lower, upper]) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const v = row[key];
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function rsStr(row, pascalName) {
  const v = rsGet(row, pascalName);
  if (v == null) return '';
  return String(v).trim();
}

function clientePayload(row) {
  return {
    id: rsGet(row, 'Id'),
    email: rsStr(row, 'Email'),
    telefone: rsStr(row, 'Telefone'),
    nome: rsStr(row, 'Nome'),
    sobrenome: rsStr(row, 'Sobrenome'),
    apelido: rsStr(row, 'Apelido'),
    fotoPerfil: rsStr(row, 'FotoPerfil'),
  };
}

/**
 * msnodesqlv8 monta Server como "host,porta" ou "host\instância".
 * Sem porta explícita vira "host,undefined" e quebra o ODBC.
 * No Windows o mssql usa por defeito "SQL Server Native Client 11.0" (muitas vezes inexistente);
 * usamos ODBC Driver 17+ (instalador Microsoft).
 */
function windowsSqlServerParts() {
  const raw = (process.env.DB_SERVER || 'localhost').trim();
  const instEnv = (process.env.DB_INSTANCE || '').trim();

  let server = raw;
  let instanceName = instEnv || undefined;
  let port = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;

  const bs = raw.indexOf('\\');
  if (bs > 0) {
    server = raw.slice(0, bs);
    instanceName = raw.slice(bs + 1);
  } else if (raw.includes(',')) {
    const cm = raw.indexOf(',');
    server = raw.slice(0, cm);
    port = Number(raw.slice(cm + 1));
  }

  if (!instanceName && port === undefined) {
    port = 1433;
  }

  return { server, instanceName, port };
}

const ODBC_DRIVER_DEFAULT = 'ODBC Driver 17 for SQL Server';

function sqlHealthUserHint(err) {
  const m = String(err?.message || err || '');
  if (/ODBC Driver Manager|fonte de dados|data source name not found|IM002/i.test(m)) {
    return `Driver ODBC em falta ou nome errado. Instale "Microsoft ODBC Driver 17 ou 18 for SQL Server". Opcional no .env: DB_ODBC_DRIVER= (nome exato na lista de drivers ODBC 64-bit do Windows). Padrão do servidor: ${ODBC_DRIVER_DEFAULT}.`;
  }
  if (/login failed|Logon failed|18456/i.test(m)) {
    return 'Autenticação falhou: permissões Windows no SQL ou credenciais SQL incorrectas.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) {
    return 'Não foi possível alcançar o SQL: confirme DB_SERVER, porta TCP (1433) e firewall.';
  }
  if (/certificate|SSL|self-signed|0x80092053|chain/i.test(m)) {
    return 'Problema de certificado TLS: no .env tente DB_ENCRYPT=false ou mantenha DB_TRUST_SERVER_CERTIFICATE=true e reinicie o backend.';
  }
  if (/cannot open database|4060/i.test(m)) {
    return 'O login funcionou mas o nome da base (DB_NAME) está errado ou a base não existe.';
  }
  return null;
}

const wSql = useWindowsAuth ? windowsSqlServerParts() : null;

/** Chaves ODBC: `}` dentro do nome do driver duplica-se (`}}`). */
function odbcDriverBraced(driverName) {
  return '{' + String(driverName).replace(/}/g, '}}') + '}';
}

/**
 * Connection string manual: o driver msnodesqlv8 do pacote `mssql` não envia
 * TrustServerCertificate — o ODBC 18 falha em muitos SQL locais sem isto.
 */
/**
 * Cláusula Server= para ODBC.
 * Por omissão, sem ",1433": o cliente ODBC/SQL costuma alinhar com o SSMS (pipes / resolução).
 * Forçar TCP explícito: DB_SQL_USE_TCP_PORT=true (usa host,porta do .env / 1433).
 * Valor livre: DB_ODBC_SERVER=(local) | . | localhost | host,porta | host\instância
 */
function odbcServerClause() {
  const override = (process.env.DB_ODBC_SERVER || '').trim();
  if (override) return override;
  const w = wSql;
  if (w.instanceName) return `${w.server}\\${w.instanceName}`;
  const forceTcp =
    process.env.DB_SQL_USE_TCP_PORT === 'true' || process.env.DB_SQL_USE_TCP_PORT === '1';
  if (forceTcp) return `${w.server},${w.port}`;
  return w.server;
}

function buildWindowsOdbcConnectionString() {
  const w = wSql;
  const driver = process.env.DB_ODBC_DRIVER || ODBC_DRIVER_DEFAULT;
  const dbName = process.env.DB_NAME || 'CacauParque';
  const serverPart = odbcServerClause();
  const encrypt = process.env.DB_ENCRYPT !== 'false' ? 'yes' : 'no';
  const trust = process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false' ? 'yes' : 'no';
  return [
    `Driver=${odbcDriverBraced(driver)}`,
    `Server=${serverPart}`,
    `Database=${dbName}`,
    'Trusted_Connection=yes',
    `Encrypt=${encrypt}`,
    `TrustServerCertificate=${trust}`,
  ].join(';');
}

/** SQL auth (tedious): instância nomeada via options.instanceName. */
const poolConfig = useWindowsAuth
  ? {
      connectionString: buildWindowsOdbcConnectionString(),
      server: wSql.server,
      port: wSql.port,
      database: process.env.DB_NAME || 'CacauParque',
      driver: process.env.DB_ODBC_DRIVER || ODBC_DRIVER_DEFAULT,
      connectionTimeout: 20000,
      requestTimeout: 20000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
      options: {
        trustedConnection: true,
        encrypt: process.env.DB_ENCRYPT !== 'false',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
        ...(wSql.instanceName ? { instanceName: wSql.instanceName } : {}),
      },
    }
  : {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER || 'localhost',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
      database: process.env.DB_NAME || 'CacauParque',
      connectionTimeout: 20000,
      requestTimeout: 20000,
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
      options: {
        encrypt: process.env.DB_ENCRYPT !== 'false',
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== 'false',
        ...(process.env.DB_INSTANCE ? { instanceName: process.env.DB_INSTANCE } : {}),
      },
    };

let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(poolConfig);
  }
  return poolPromise;
}

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  if (!value || typeof value !== 'string') return false;
  return EMAIL_REGEX.test(value.trim().toLowerCase());
}

function parseDateOnly(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const s = iso.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y < 1900 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return null;
}

function isCpfValidDigits(d) {
  if (!d || d.length !== 11 || !/^\d{11}$/.test(d)) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let r = (sum * 10) % 11;
  if (r >= 10) r = 0;
  if (r !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  r = (sum * 10) % 11;
  if (r >= 10) r = 0;
  return r === Number(d[10]);
}

/** Coluna Documento: só CPF com 11 dígitos ou null. */
function parseCpfDocumento(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { ok: true, value: null };
  if (digits.length !== 11 || !isCpfValidDigits(digits)) {
    return { ok: false, error: 'CPF inválido. Use 11 dígitos válidos ou deixe em branco.' };
  }
  return { ok: true, value: digits };
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return 'Informe uma senha.';
  }
  if (!PASSWORD_REGEX.test(password)) {
    return 'A senha deve ter no mínimo 8 caracteres, incluindo uma maiúscula, uma minúscula, um número e um caractere especial.';
  }
  return null;
}

async function ensureEnderecosTable(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.Enderecos', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Enderecos (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ClienteId INT NOT NULL,
        Rua NVARCHAR(160) NULL,
        Bairro NVARCHAR(120) NULL,
        Pais NVARCHAR(80) NULL,
        Cep NVARCHAR(20) NULL,
        Numero NVARCHAR(20) NULL,
        CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_CriadoEm_Api DEFAULT (SYSDATETIME()),
        AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_Enderecos_AtualizadoEm_Api DEFAULT (SYSDATETIME()),
        CONSTRAINT FK_Enderecos_Clientes_Api FOREIGN KEY (ClienteId) REFERENCES dbo.Clientes(Id) ON DELETE CASCADE
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = 'UX_Enderecos_ClienteId'
        AND object_id = OBJECT_ID('dbo.Enderecos')
    )
    BEGIN
      CREATE UNIQUE INDEX UX_Enderecos_ClienteId ON dbo.Enderecos (ClienteId);
    END;
  `);
}

let dbCompatReadyPromise = null;
function ensureDbCompat() {
  if (!dbCompatReadyPromise) {
    dbCompatReadyPromise = (async () => {
      const pool = await getPool();
      await pool.request().query(`
        IF COL_LENGTH('dbo.Clientes', 'Nome') IS NULL
          ALTER TABLE dbo.Clientes ADD Nome NVARCHAR(120) NULL;
        IF COL_LENGTH('dbo.Clientes', 'Sobrenome') IS NULL
          ALTER TABLE dbo.Clientes ADD Sobrenome NVARCHAR(120) NULL;
        IF COL_LENGTH('dbo.Clientes', 'Apelido') IS NULL
          ALTER TABLE dbo.Clientes ADD Apelido NVARCHAR(120) NULL;
        IF COL_LENGTH('dbo.Clientes', 'Telefone') IS NULL
          ALTER TABLE dbo.Clientes ADD Telefone NVARCHAR(20) NULL;
        IF COL_LENGTH('dbo.Clientes', 'FotoPerfil') IS NULL
          ALTER TABLE dbo.Clientes ADD FotoPerfil NVARCHAR(MAX) NULL;

        IF COL_LENGTH('dbo.Clientes', 'FotoPerfil') IS NOT NULL
          AND (
            SELECT max_length
            FROM sys.columns
            WHERE object_id = OBJECT_ID('dbo.Clientes')
              AND name = 'FotoPerfil'
          ) <> -1
          ALTER TABLE dbo.Clientes ALTER COLUMN FotoPerfil NVARCHAR(MAX) NULL;
      `);
      await ensureEnderecosTable(pool);
    })();
  }
  return dbCompatReadyPromise;
}

async function hashGooglePlaceholder() {
  return bcrypt.hash('__google_oauth_only__', 10);
}

app.get('/api/health', async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS n');
    return res.json({ ok: true, db: true });
  } catch (err) {
    console.error('Health / SQL:', err?.message || err);
    const hint = sqlHealthUserHint(err);
    const body = {
      ok: false,
      db: false,
      error: 'SQL Server não respondeu. Confira .env, serviço SQL e firewall.',
      detail: String(err?.message || err),
      ...(hint ? { hint } : {}),
    };
    return res.status(503).json(body);
  }
});

/**
 * Mapa: retorna hotspots/locais do mapa para um parque.
 * Query: ?parqueCodigo=cacau-parque
 */
app.get('/api/mapa/locais', async (req, res) => {
  try {
    const parqueCodigo = String(req.query?.parqueCodigo ?? 'cacau-parque').trim();

    const pool = await getPool();

    const parque = await pool
      .request()
      .input('codigo', sql.NVarChar(50), parqueCodigo)
      .query(`SELECT Id FROM dbo.Parques WHERE Codigo = @codigo AND Ativo = 1`);

    if (!parque.recordset || parque.recordset.length === 0) {
      return res.status(404).json({ ok: false, error: 'Parque não encontrado.' });
    }

    const parqueId = rsGet(parque.recordset[0], 'Id');

    const locais = await pool
      .request()
      .input('parqueId', sql.Int, parqueId)
      .query(`
        SELECT
          Codigo,
          Nome,
          Tipo,
          Descricao,
          Categoria,
          Classificacao,
          AlturaMinCm,
          Aberto,
          TempoFilaMin,
          ImagemUrl,
          IconeMapaUrl,
          X, Y, Largura, Altura,
          Ordem
        FROM dbo.MapaLocais
        WHERE ParqueId = @parqueId AND Ativo = 1
        ORDER BY Ordem, Nome;
      `);

    const recordset = locais.recordset || [];
    const locaisOut = recordset.map((row) => {
      const descRaw = rsGet(row, 'Descricao');
      const desc = descRaw == null ? undefined : String(descRaw).trim();

      const catRaw = rsGet(row, 'Categoria');
      const cat = catRaw == null ? undefined : String(catRaw).trim();

      const clasRaw = rsGet(row, 'Classificacao');
      const clas = clasRaw == null ? undefined : String(clasRaw).trim();

      const imgRaw = rsGet(row, 'ImagemUrl');
      const img = imgRaw == null ? undefined : String(imgRaw).trim();

      const iconeRaw = rsGet(row, 'IconeMapaUrl');
      const iconeMapa =
        iconeRaw == null ? undefined : String(iconeRaw).trim();

      const abertoRaw = rsGet(row, 'Aberto');
      const aberto =
        abertoRaw == null ? undefined : Boolean(Number(abertoRaw));

      const tempoFilaRaw = rsGet(row, 'TempoFilaMin');
      const tempoFila =
        tempoFilaRaw == null ? undefined : Number(tempoFilaRaw);

      const alturaMinRaw = rsGet(row, 'AlturaMinCm');
      const alturaMin =
        alturaMinRaw == null ? undefined : Number(alturaMinRaw);

      const xRaw = rsGet(row, 'X');
      const yRaw = rsGet(row, 'Y');
      const wRaw = rsGet(row, 'Largura');
      const hRaw = rsGet(row, 'Altura');

      return {
        codigo: rsStr(row, 'Codigo'),
        nome: rsStr(row, 'Nome'),
        tipo: rsStr(row, 'Tipo'),
        descricao: desc || undefined,
        categoria: cat || undefined,
        classificacao: clas || undefined,
        alturaMinCm: alturaMin,
        aberto,
        tempoFilaMin: tempoFila,
        imagemUrl: img || undefined,
        iconeMapaUrl: iconeMapa || undefined,
        x: Number(xRaw),
        y: Number(yRaw),
        w: Number(wRaw),
        h: Number(hRaw),
      };
    });

    return res.json({ ok: true, parqueCodigo, locais: locaisOut });
  } catch (err) {
    console.error('GET /api/mapa/locais:', err);
    return res.status(500).json({
      ok: false,
      error: 'Falha ao carregar locais do mapa.',
      detail: String(err?.message || err),
    });
  }
});

/**
 * Login: e-mail deve existir; valida senha.
 */
app.post('/api/auth/entrar', async (req, res) => {
  try {
    await ensureDbCompat();
    const emailRaw = (req.body?.email || '').trim().toLowerCase();
    const password =
      typeof req.body?.password === 'string' ? req.body.password.trim() : '';

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({ error: 'E-mail incorreto' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Informe a senha.' });
    }

    const pool = await getPool();
    const existing = await pool
      .request()
      .input('email', sql.NVarChar(180), emailRaw)
      .query(
        'SELECT Id, Email, Telefone, SenhaHash, Nome, Sobrenome, Apelido, FotoPerfil FROM dbo.Clientes WHERE Email = @email AND Ativo = 1'
      );

    if (existing.recordset.length === 0) {
      return res.status(404).json({ error: 'Este e-mail não está cadastrado' });
    }

    const cliente = existing.recordset[0];
    const senhaHash = rsGet(cliente, 'SenhaHash');
    const ok = await bcrypt.compare(password, senhaHash);
    if (!ok) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const clienteId = rsGet(cliente, 'Id');
    await pool
      .request()
      .input('id', sql.Int, clienteId)
      .query(
        `UPDATE dbo.Clientes SET UltimoLoginEm = SYSDATETIME(), AtualizadoEm = SYSDATETIME() WHERE Id = @id`
      );

    return res.json({
      ok: true,
      cliente: clientePayload(cliente),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro no servidor. Verifique a conexão com o banco.' });
  }
});

/**
 * Cadastro completo (após informar que o e-mail não existia).
 */
app.post('/api/auth/cadastro', async (req, res) => {
  try {
    await ensureDbCompat();
    const emailRaw = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    const apelido = (req.body?.nome || '').trim();
    const dataNascimentoRaw = req.body?.dataNascimento;
    const telefone = (req.body?.telefone || '').trim() || null;
    const cpfDoc = parseCpfDocumento(req.body?.documento);
    if (!cpfDoc.ok) {
      return res.status(400).json({ error: cpfDoc.error });
    }
    const documento = cpfDoc.value;

    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({ error: 'E-mail incorreto' });
    }

    const pwdErr = validatePasswordStrength(password);
    if (pwdErr) {
      return res.status(400).json({ error: pwdErr });
    }

    if (apelido.length < 2) {
      return res.status(400).json({
        error: 'Informe como quer ser chamado (mínimo 2 caracteres).',
      });
    }

    const dataNascimento = parseDateOnly(
      typeof dataNascimentoRaw === 'string' ? dataNascimentoRaw : ''
    );
    if (!dataNascimento) {
      return res.status(400).json({
        error: 'Data de nascimento inválida. Use DD/MM/AAAA ou AAAA-MM-DD.',
      });
    }

    const pool = await getPool();
    const dup = await pool
      .request()
      .input('email', sql.NVarChar(180), emailRaw)
      .query('SELECT Id FROM dbo.Clientes WHERE Email = @email');

    if (dup.recordset.length > 0) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    }

    const hash = await bcrypt.hash(password, 12);

    const [yStr, moStr, dStr] = dataNascimento.split('-');
    const y = Number(yStr);
    const mo = Number(moStr);
    const d = Number(dStr);
    const dataNascimentoDate = new Date(Date.UTC(y, mo - 1, d));

    const insert = await pool
      .request()
      .input('nome', sql.NVarChar(120), null)
      .input('sobrenome', sql.NVarChar(120), null)
      .input('apelido', sql.NVarChar(120), apelido)
      .input('email', sql.NVarChar(180), emailRaw)
      .input('senhaHash', sql.NVarChar(255), hash)
      .input('dataNascimento', sql.Date, dataNascimentoDate)
      .input('telefone', sql.NVarChar(20), telefone)
      .input('documento', sql.NVarChar(14), documento)
      .query(
        `INSERT INTO dbo.Clientes (Nome, Sobrenome, Apelido, Email, SenhaHash, DataNascimento, Telefone, Documento, CriadoEm, AtualizadoEm)
         OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
         VALUES (@nome, @sobrenome, @apelido, @email, @senhaHash, @dataNascimento, @telefone, @documento, SYSDATETIME(), SYSDATETIME())`
      );

    const created = insert.recordset[0];
    return res.status(201).json({
      ok: true,
      cliente: clientePayload(created),
    });
  } catch (err) {
    console.error('cadastro:', err?.message || err);
    const detail = String(err?.message || err?.originalError?.info?.message || '');
    return res.status(500).json({
      error:
        'Erro ao cadastrar. No SSMS execute sql/clientes_colunas_extras.sql no banco CacauParque (ou use auth_schema.sql numa base nova).',
      ...(detail ? { detail } : {}),
    });
  }
});

/**
 * Login com Google: valida idToken e upsert Cliente + AuthExterno.
 */
app.post('/api/auth/google', async (req, res) => {
  try {
    await ensureDbCompat();
    const idToken = req.body?.idToken;

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'Token do Google ausente.' });
    }

    const audiences = [GOOGLE_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID].filter(Boolean);
    if (audiences.length === 0) {
      return res.status(500).json({
        error: 'Configure GOOGLE_CLIENT_ID (Web) e/ou GOOGLE_ANDROID_CLIENT_ID no .env do backend.',
      });
    }

    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({
      idToken,
      audience: audiences.length === 1 ? audiences[0] : audiences,
    });
    const payload = ticket.getPayload();
    const googleSub = payload?.sub;
    const email = (payload?.email || '').trim().toLowerCase();
    const nomeGoogleRaw = (payload?.given_name || payload?.name || '').trim();
    const nomeGoogle =
      nomeGoogleRaw.length > 120 ? nomeGoogleRaw.slice(0, 120) : nomeGoogleRaw || null;

    if (!googleSub || !email) {
      return res.status(400).json({ error: 'Não foi possível obter e-mail do Google.' });
    }

    const pool = await getPool();
    const placeholderHash = await hashGooglePlaceholder();

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      const reqTx = new sql.Request(tx);
      const link = await reqTx
        .input('provider', sql.NVarChar(30), 'google')
        .input('sub', sql.NVarChar(120), googleSub)
        .query(
          `SELECT c.Id, c.Email, c.Telefone, c.Nome, c.Sobrenome, c.Apelido, c.FotoPerfil
           FROM dbo.AuthExterno a
           INNER JOIN dbo.Clientes c ON c.Id = a.ClienteId
           WHERE a.Provider = @provider AND a.ProviderUserId = @sub`
        );

      if (link.recordset.length > 0) {
        const row = link.recordset[0];
        const rowId = rsGet(row, 'Id');
        await new sql.Request(tx)
          .input('id', sql.Int, rowId)
          .query(
            `UPDATE dbo.Clientes SET UltimoLoginEm = SYSDATETIME(), AtualizadoEm = SYSDATETIME() WHERE Id = @id`
          );
        await tx.commit();
        return res.json({
          ok: true,
          criado: false,
          cliente: clientePayload(row),
        });
      }

      const byEmail = await new sql.Request(tx)
        .input('email', sql.NVarChar(180), email)
        .query(`SELECT Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil FROM dbo.Clientes WHERE Email = @email`);

      let clienteId;

      let clienteResposta;

      if (byEmail.recordset.length > 0) {
        const found = byEmail.recordset[0];
        clienteId = rsGet(found, 'Id');
        clienteResposta = clientePayload(found);
      } else {
        const ins = await new sql.Request(tx)
          .input('nome', sql.NVarChar(120), null)
          .input('sobrenome', sql.NVarChar(120), null)
          .input('apelido', sql.NVarChar(120), nomeGoogle)
          .input('email', sql.NVarChar(180), email)
          .input('senhaHash', sql.NVarChar(255), placeholderHash)
          .query(
            `INSERT INTO dbo.Clientes (Nome, Sobrenome, Apelido, Email, SenhaHash, DataNascimento, Telefone, Documento, CriadoEm, AtualizadoEm)
             OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
             VALUES (@nome, @sobrenome, @apelido, @email, @senhaHash, NULL, NULL, NULL, SYSDATETIME(), SYSDATETIME())`
          );
        clienteId = rsGet(ins.recordset[0], 'Id');
        clienteResposta = clientePayload(ins.recordset[0]);
      }

      await new sql.Request(tx)
        .input('clienteId', sql.Int, clienteId)
        .input('provider', sql.NVarChar(30), 'google')
        .input('sub', sql.NVarChar(120), googleSub)
        .query(
          `INSERT INTO dbo.AuthExterno (ClienteId, Provider, ProviderUserId) VALUES (@clienteId, @provider, @sub)`
        );

      await new sql.Request(tx)
        .input('id', sql.Int, clienteId)
        .query(
          `UPDATE dbo.Clientes SET UltimoLoginEm = SYSDATETIME(), AtualizadoEm = SYSDATETIME() WHERE Id = @id`
        );

      await tx.commit();

      return res.json({
        ok: true,
        criado: true,
        cliente: {
          ...clienteResposta,
          id: clienteId,
          email,
        },
      });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  } catch (err) {
    console.error(err);
    if (err?.number === 2627 || err?.code === 'EREQUEST') {
      return res.status(409).json({ error: 'Conta já vinculada ou e-mail em uso.' });
    }
    return res.status(500).json({ error: 'Falha ao validar o Google ou salvar no banco.' });
  }
});

app.put('/api/clientes/:id/perfil-pessoal', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }

    const nomeRaw = String(req.body?.nome || '').trim();
    const sobrenomeRaw = String(req.body?.sobrenome || '').trim();
    const apelidoRaw = String(req.body?.apelido || '').trim();
    if (apelidoRaw.length < 2) {
      return res.status(400).json({ error: 'Apelido deve ter pelo menos 2 caracteres.' });
    }

    const nome = nomeRaw ? nomeRaw.slice(0, 120) : null;
    const sobrenome = sobrenomeRaw ? sobrenomeRaw.slice(0, 120) : null;
    const apelido = apelidoRaw.slice(0, 120);

    const pool = await getPool();
    const update = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('nome', sql.NVarChar(120), nome)
      .input('sobrenome', sql.NVarChar(120), sobrenome)
      .input('apelido', sql.NVarChar(120), apelido)
      .query(`
        UPDATE dbo.Clientes
        SET Nome = @nome,
            Sobrenome = @sobrenome,
            Apelido = @apelido,
            AtualizadoEm = SYSDATETIME()
        OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
        WHERE Id = @id AND Ativo = 1;
      `);

    if (!update.recordset || update.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    return res.json({ ok: true, cliente: clientePayload(update.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/:id/perfil-pessoal:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar informações pessoais.' });
  }
});

app.put('/api/clientes/perfil-pessoal', async (req, res) => {
  try {
    const idRaw = req.body?.id;
    const emailRaw = String(req.body?.email || '').trim().toLowerCase();
    const nomeRaw = String(req.body?.nome || '').trim();
    const sobrenomeRaw = String(req.body?.sobrenome || '').trim();
    const apelidoRaw = String(req.body?.apelido || '').trim();

    if (apelidoRaw.length < 2) {
      return res.status(400).json({ error: 'Apelido deve ter pelo menos 2 caracteres.' });
    }

    const id = Number(idRaw);
    const hasId = Number.isInteger(id) && id > 0;
    if (!hasId && !isValidEmail(emailRaw)) {
      return res.status(400).json({ error: 'Informe um id válido ou e-mail válido.' });
    }

    const nome = nomeRaw ? nomeRaw.slice(0, 120) : null;
    const sobrenome = sobrenomeRaw ? sobrenomeRaw.slice(0, 120) : null;
    const apelido = apelidoRaw.slice(0, 120);

    const pool = await getPool();
    const reqUp = pool
      .request()
      .input('nome', sql.NVarChar(120), nome)
      .input('sobrenome', sql.NVarChar(120), sobrenome)
      .input('apelido', sql.NVarChar(120), apelido);

    let update;
    if (hasId) {
      update = await reqUp
        .input('id', sql.Int, id)
        .query(`
          UPDATE dbo.Clientes
          SET Nome = @nome,
              Sobrenome = @sobrenome,
              Apelido = @apelido,
              AtualizadoEm = SYSDATETIME()
          OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
          WHERE Id = @id AND Ativo = 1;
        `);
    } else {
      update = await reqUp
        .input('email', sql.NVarChar(180), emailRaw)
        .query(`
          UPDATE dbo.Clientes
          SET Nome = @nome,
              Sobrenome = @sobrenome,
              Apelido = @apelido,
              AtualizadoEm = SYSDATETIME()
          OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
          WHERE Email = @email AND Ativo = 1;
        `);
    }

    if (!update.recordset || update.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(update.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/perfil-pessoal:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar informações pessoais.' });
  }
});

app.put('/api/clientes/:id/contato', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }

    const emailRaw = String(req.body?.email || '').trim().toLowerCase();
    const telefoneRaw = String(req.body?.telefone || '').trim();
    if (!isValidEmail(emailRaw)) {
      return res.status(400).json({ error: 'E-mail incorreto.' });
    }
    const telefone = telefoneRaw ? telefoneRaw.slice(0, 20) : null;

    const pool = await getPool();
    const dup = await pool
      .request()
      .input('email', sql.NVarChar(180), emailRaw)
      .input('id', sql.Int, clienteId)
      .query('SELECT TOP 1 Id FROM dbo.Clientes WHERE Email = @email AND Id <> @id');
    if (dup.recordset && dup.recordset.length > 0) {
      return res.status(409).json({ error: 'Este e-mail já está em uso por outra conta.' });
    }

    const update = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('email', sql.NVarChar(180), emailRaw)
      .input('telefone', sql.NVarChar(20), telefone)
      .query(`
        UPDATE dbo.Clientes
        SET Email = @email,
            Telefone = @telefone,
            AtualizadoEm = SYSDATETIME()
        OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
        WHERE Id = @id AND Ativo = 1;
      `);

    if (!update.recordset || update.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(update.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/:id/contato:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar informações de contato.' });
  }
});

app.put('/api/clientes/:id/senha', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }

    const senhaAtual =
      typeof req.body?.senhaAtual === 'string' ? req.body.senhaAtual.trim() : '';
    const novaSenha =
      typeof req.body?.novaSenha === 'string' ? req.body.novaSenha.trim() : '';

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ error: 'Informe senha atual e nova senha.' });
    }
    if (senhaAtual === novaSenha) {
      return res.status(400).json({ error: 'A nova senha deve ser diferente da senha atual.' });
    }
    const pwdErr = validatePasswordStrength(novaSenha);
    if (pwdErr) {
      return res.status(400).json({ error: pwdErr });
    }

    const pool = await getPool();
    const existing = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .query('SELECT Id, SenhaHash FROM dbo.Clientes WHERE Id = @id AND Ativo = 1');
    if (!existing.recordset || existing.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const row = existing.recordset[0];
    const senhaHash = rsGet(row, 'SenhaHash');
    const ok = await bcrypt.compare(senhaAtual, senhaHash);
    if (!ok) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }

    const novoHash = await bcrypt.hash(novaSenha, 12);
    await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('senhaHash', sql.NVarChar(255), novoHash)
      .query(`
        UPDATE dbo.Clientes
        SET SenhaHash = @senhaHash,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @id AND Ativo = 1;
      `);

    return res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/clientes/:id/senha:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar senha.' });
  }
});

app.put('/api/clientes/senha', async (req, res) => {
  try {
    const idRaw = req.body?.id;
    const emailRaw = String(req.body?.email || '').trim().toLowerCase();
    const senhaAtual =
      typeof req.body?.senhaAtual === 'string' ? req.body.senhaAtual.trim() : '';
    const novaSenha =
      typeof req.body?.novaSenha === 'string' ? req.body.novaSenha.trim() : '';

    const id = Number(idRaw);
    const hasId = Number.isInteger(id) && id > 0;
    if (!hasId && !isValidEmail(emailRaw)) {
      return res.status(400).json({ error: 'Informe um id válido ou e-mail válido.' });
    }
    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ error: 'Informe senha atual e nova senha.' });
    }
    if (senhaAtual === novaSenha) {
      return res.status(400).json({ error: 'A nova senha deve ser diferente da senha atual.' });
    }
    const pwdErr = validatePasswordStrength(novaSenha);
    if (pwdErr) {
      return res.status(400).json({ error: pwdErr });
    }

    const pool = await getPool();
    const existing = hasId
      ? await pool
          .request()
          .input('id', sql.Int, id)
          .query('SELECT TOP 1 Id, SenhaHash FROM dbo.Clientes WHERE Id = @id AND Ativo = 1')
      : await pool
          .request()
          .input('email', sql.NVarChar(180), emailRaw)
          .query('SELECT TOP 1 Id, SenhaHash FROM dbo.Clientes WHERE Email = @email AND Ativo = 1');

    if (!existing.recordset || existing.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const row = existing.recordset[0];
    const clienteId = rsGet(row, 'Id');
    const ok = await bcrypt.compare(senhaAtual, rsGet(row, 'SenhaHash'));
    if (!ok) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }

    const novoHash = await bcrypt.hash(novaSenha, 12);
    await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('senhaHash', sql.NVarChar(255), novoHash)
      .query(`
        UPDATE dbo.Clientes
        SET SenhaHash = @senhaHash,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @id AND Ativo = 1;
      `);
    return res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/clientes/senha:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar senha.' });
  }
});

app.get('/api/clientes/:id/endereco', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    const pool = await getPool();
    await ensureEnderecosTable(pool);
    const rows = await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .query(`
        SELECT TOP 1 Rua, Bairro, Pais, Cep, Numero
        FROM dbo.Enderecos
        WHERE ClienteId = @clienteId;
      `);
    const row = rows.recordset?.[0];
    return res.json({
      ok: true,
      endereco: row
        ? {
            rua: rsStr(row, 'Rua'),
            bairro: rsStr(row, 'Bairro'),
            pais: rsStr(row, 'Pais'),
            cep: rsStr(row, 'Cep'),
            numero: rsStr(row, 'Numero'),
          }
        : { rua: '', bairro: '', pais: '', cep: '', numero: '' },
    });
  } catch (err) {
    console.error('GET /api/clientes/:id/endereco:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao carregar endereço.' });
  }
});

app.put('/api/clientes/:id/endereco', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    const rua = String(req.body?.rua || '').trim().slice(0, 160);
    const bairro = String(req.body?.bairro || '').trim().slice(0, 120);
    const pais = String(req.body?.pais || '').trim().slice(0, 80);
    const cep = String(req.body?.cep || '').trim().slice(0, 20);
    const numero = String(req.body?.numero || '').trim().slice(0, 20);

    const pool = await getPool();
    await ensureEnderecosTable(pool);
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('rua', sql.NVarChar(160), rua || null)
      .input('bairro', sql.NVarChar(120), bairro || null)
      .input('pais', sql.NVarChar(80), pais || null)
      .input('cep', sql.NVarChar(20), cep || null)
      .input('numero', sql.NVarChar(20), numero || null)
      .query(`
        MERGE dbo.Enderecos AS target
        USING (SELECT @clienteId AS ClienteId) AS src
        ON target.ClienteId = src.ClienteId
        WHEN MATCHED THEN
          UPDATE SET Rua = @rua, Bairro = @bairro, Pais = @pais, Cep = @cep, Numero = @numero, AtualizadoEm = SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (ClienteId, Rua, Bairro, Pais, Cep, Numero, CriadoEm, AtualizadoEm)
          VALUES (@clienteId, @rua, @bairro, @pais, @cep, @numero, SYSDATETIME(), SYSDATETIME());
      `);

    return res.json({
      ok: true,
      endereco: { rua, bairro, pais, cep, numero },
    });
  } catch (err) {
    console.error('PUT /api/clientes/:id/endereco:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao salvar endereço.' });
  }
});

app.put('/api/clientes/:id/foto', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    const fotoPerfil = String(req.body?.fotoPerfil || '').trim();
    if (!fotoPerfil) {
      return res.status(400).json({ error: 'Foto inválida.' });
    }

    const pool = await getPool();
    await ensureDbCompat();
    const update = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('fotoPerfil', sql.NVarChar(sql.MAX), fotoPerfil)
      .query(`
        UPDATE dbo.Clientes
        SET FotoPerfil = @fotoPerfil,
            AtualizadoEm = SYSDATETIME()
        OUTPUT INSERTED.Id, INSERTED.Email, INSERTED.Telefone, INSERTED.Nome, INSERTED.Sobrenome, INSERTED.Apelido, INSERTED.FotoPerfil
        WHERE Id = @id AND Ativo = 1;
      `);
    if (!update.recordset || update.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(update.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/:id/foto:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao salvar foto de perfil.',
      detail: String(err?.message || err),
    });
  }
});

app.delete('/api/clientes/:id', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .query('DELETE FROM dbo.Clientes WHERE Id = @id;');

    if (!result.rowsAffected || result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/clientes/:id:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao excluir conta.' });
  }
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`API em http://localhost:${PORT}`);
  const authLabel = useWindowsAuth
    ? 'Windows (trusted)'
    : poolConfig.user || '(defina DB_USER no .env)';
  const sqlBits = [poolConfig.server, poolConfig.database];
  if (useWindowsAuth && poolConfig.options?.instanceName) {
    sqlBits.push(`instance=${poolConfig.options.instanceName}`);
  }
  if (!useWindowsAuth && process.env.DB_INSTANCE) {
    sqlBits.push(`instance=${process.env.DB_INSTANCE}`);
  }
  if (useWindowsAuth) {
    sqlBits.push(`odbcServer=${odbcServerClause()}`, `driver=${poolConfig.driver}`);
  } else if (poolConfig.port) {
    sqlBits.push(`port=${poolConfig.port}`);
  } else {
    sqlBits.push('porta padrão / Browser');
  }
  console.log('SQL Server:', sqlBits.join(' '), '| auth:', authLabel);
  if (useWindowsAuth) {
    console.log('ODBC Server=', odbcServerClause());
  }
});

httpServer.on('error', (err) => {
  console.error('Falha ao abrir a porta HTTP:', err.message);
  process.exitCode = 1;
});
