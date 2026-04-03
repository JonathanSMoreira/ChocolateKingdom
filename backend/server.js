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
const GOOGLE_IOS_CLIENT_ID = process.env.GOOGLE_IOS_CLIENT_ID || '';

const app = express();
app.use(cors({ origin: true }));
// Upload de foto de perfil em base64 pode ultrapassar o limite padrão (100kb).
app.use(express.json({ limit: '50mb' }));
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

/** BIT/TINYINT vindos do SQL (mssql/ODBC): boolean, Buffer ou número. */
function sqlBitIsOne(raw) {
  if (raw == null || raw === '') return false;
  if (typeof raw === 'boolean') return raw === true;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return raw.length > 0 && raw[0] === 1;
  }
  const n = Number(raw);
  return !Number.isNaN(n) && n === 1;
}

/**
 * Funcionarios.Ativos: apenas 0/false explícito = inativo.
 * NULL (sem coluna preenchida) = ativo para não bloquear a API com cadastro legado.
 */
function sqlFuncionarioEstaAtivo(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw === 'boolean') return raw === true;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    if (raw.length === 0) return true;
    return raw[0] !== 0;
  }
  const n = Number(raw);
  if (Number.isNaN(n)) return true;
  return n !== 0;
}

/** ODBC/msnodesqlv8: lotes UPDATE; SELECT podem não preencher `recordset` como o Tedious; usar rowsAffected + SELECT separado. */
function rowsAffectedFirst(result) {
  const ra = result?.rowsAffected;
  if (Array.isArray(ra) && ra.length > 0) return Number(ra[0]) || 0;
  if (typeof ra === 'number' && !Number.isNaN(ra)) return ra;
  return 0;
}

function clientePayload(row) {
  const payload = {
    id: rsGet(row, 'Id'),
    email: rsStr(row, 'Email'),
    telefone: rsStr(row, 'Telefone'),
    nome: rsStr(row, 'Nome'),
    sobrenome: rsStr(row, 'Sobrenome'),
    apelido: rsStr(row, 'Apelido'),
    fotoPerfil: rsStr(row, 'FotoPerfil'),
    funcionario: Number(rsGet(row, 'Funcionario') || 0) === 1,
    funcionarioAtivo: Number(rsGet(row, 'FuncionarioAtivo') || 0) === 1,
  };
  const stRaw = rsGet(row, 'StatusTrabalho');
  if (stRaw !== undefined && stRaw !== null && stRaw !== '') {
    payload.statusTrabalho = normalizeStatusTrabalhoDb(stRaw);
  }
  return payload;
}

/** Não bloqueia o login se só faltar coluna de auditoria ou houver falha transitória. */
async function atualizarAuditoriaLogin(pool, clienteId, tx = null) {
  try {
    const rq = tx ? new sql.Request(tx) : pool.request();
    await rq
      .input('id', sql.Int, clienteId)
      .query(
        `UPDATE dbo.Clientes SET UltimoLoginEm = SYSDATETIME(), AtualizadoEm = SYSDATETIME() WHERE Id = @id`
      );
  } catch (e) {
    console.error('Auditoria login (UltimoLoginEm/AtualizadoEm):', e?.message || e);
  }
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

function normalizeTextKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeSetorValue(setor) {
  const key = normalizeTextKey(setor);
  if (key === 'gerencia') return 'Administrativo';
  return String(setor || '').trim();
}

function isHighLevelCargo(cargo) {
  const key = normalizeTextKey(cargo);
  return (
    key.includes('coordenador geral') ||
    key.includes('coordenador senior') ||
    key.includes('gerente') ||
    key.includes('lider')
  );
}

/**
 * Hierarquia numérica maior = cargo mais alto.
 * Ordem: gerente → coordenador → supervisor → encarregado → líder → analista → assistente → auxiliar.
 */
function cargoHierarchyRank(cargo) {
  const k = normalizeTextKey(cargo);
  if (!k) return 0;
  if (k.includes('gerente') || k.includes('gestor') || k.includes('diretor')) return 50;
  if (k.includes('coordenador')) return 40;
  if (k.includes('supervisor')) return 30;
  if (k.includes('encarregad')) return 20;
  if (k.includes('lider')) return 15;
  if (k.includes('analista')) return 14;
  if (k.includes('assistente')) return 12;
  if (k.includes('auxiliar')) return 10;
  return 5;
}

/**
 * Desempate dentro do mesmo rank (agrupamento): maior = mais acima na lista.
 * Coordenadores: Geral → Administrativo → … demais; base: Analista > Assistente > Auxiliar.
 */
function cargoSecundarioSortKey(cargo) {
  const k = normalizeTextKey(cargo);
  if (!k) return 0;
  if (k.includes('coordenador')) {
    if (k.includes('coordenador geral')) return 10000;
    if (k.includes('administrativ')) return 9990;
    if (k.includes('senior') || k.includes('sênior')) return 9980;
    if (/\bti\b/.test(k) || k.includes('de ti') || k.includes('coordenador ti')) return 9970;
    if (k.includes('seguranca') || k.includes('segurança')) return 9960;
    if (k.includes('operacoes') || k.includes('operações')) return 9950;
    if (k.includes('manutencao') || k.includes('manutenção')) return 9940;
    if (k.includes('atendimento')) return 9930;
    if (k.includes('alimentos')) return 9920;
    return 5000;
  }
  if (k.includes('analista')) return 250;
  if (k.includes('assistente')) return 200;
  if (k.includes('auxiliar')) return 100;
  return 0;
}

/**
 * Acesso à tela Escala: funcionário com cargo reconhecido (rank 5 = base … 50 = gestão).
 * Na API equipe-escala, rank &lt; 15 vê só o próprio nome; gestão vê subordinados.
 */
function podeAcessarEscalaTrabalho(cargo) {
  const r = cargoHierarchyRank(cargo);
  return r >= 5 && r <= 50;
}

/** Cadastro de cargos no catálogo: coordenador (40) e gerente (50), não supervisor/líder. */
function podeGerirCatalogoDeCargos(cargo) {
  return cargoHierarchyRank(cargo) >= 40;
}

/** Gestor só enxerga colaboradores estritamente abaixo na hierarquia, mesmo setor. */
function colaboradorEhSubordinadoDoCargo(cargoGestor, cargoColaborador) {
  const rg = cargoHierarchyRank(cargoGestor);
  const rc = cargoHierarchyRank(cargoColaborador);
  if (rg < 15 || rg > 50) return false;
  if (!String(cargoColaborador || '').trim()) return false;
  return rc > 0 && rc < rg;
}

/**
 * Folga no próprio dia: Gerente, Coordenador, gestor e cargo rank ≥ 40.
 * Demais cargos podem falta e justificativa no próprio dia; folga só em subordinados (ou via alto gestor).
 */
function cargoPodeFolgaEJustificativaAltoGestorNoProprio(cargo) {
  const k = normalizeTextKey(cargo);
  if (!k) return false;
  if (k.includes('gerente')) return true;
  if (k.includes('coordenador')) return true;
  if (k.includes('gestor')) return true;
  return cargoHierarchyRank(cargo) >= 40;
}

/** Banco: 1 = em serviço (Sim), 0 = fora (Não). Legado 2 tratado como 0. */
function normalizeStatusTrabalhoDb(raw) {
  const n = Number(raw);
  if (n === 1) return 1;
  return 0;
}

/** Presença no calendário: 1 = trabalhou (verde), 0 = falta (vermelho); null/omitido = neutro (cinza). */
function normalizePresencaSituacaoDb(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n === 1) return 1;
  if (n === 0 || n === 2) return 0;
  return undefined;
}

function pontoDateTimeToIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Trechos de Sim/Não gravados em PontoEletronicoDia.JornadaTrechosJson: [{ e: ISO, s: ISO|null }, ...]. */
function parseJornadaTrechosJson(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => ({
      e: typeof x.e === 'string' ? x.e : null,
      s: typeof x.s === 'string' ? x.s : null,
    }));
  } catch {
    return [];
  }
}

function serializeJornadaTrechos(segs) {
  return JSON.stringify(
    segs.map((x) => ({
      e: x.e != null ? String(x.e) : null,
      s: x.s != null ? String(x.s) : null,
    }))
  );
}

/** Evita Invalid Date no driver mssql (quebra DateTime2 e falha o PUT status-trabalho). */
function toSqlDateTime2OrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d;
}

/** Data civil de hoje em America/Sao_Paulo (YYYY-MM-DD). */
function hojeIsoSaoPaulo() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
}

/** Momento atual em Brasília como `YYYY-MM-DD HH:mm:ss` (relógio local, sem fuso no valor). */
function agoraSqlStringSaoPaulo() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Valor para gravar em DATETIME2 como horário de Brasília (o mesmo que o usuário vê no BR).
 * Evita o driver gravar o instante em UTC (+3 h em relação a Brasília na maioria do ano).
 */
function pontoHorarioParaSqlStringBrasil(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const t = v.replace('T', ' ').trim();
    return t.length >= 19 ? t.slice(0, 19) : t;
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

function readPontoDiaDateTime(row, colName) {
  if (row == null) return null;
  const v = rsGet(row, colName);
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Trechos JSON coerentes com EntradaEm, SaidaAlmocoEm, VoltaAlmocoEm, SaidaExpedienteEm.
 * 1º Sim → entrada; 1º Não → saída almoço; 2º Sim → volta almoço; 2º Não → saída expediente.
 */
function trechosJsonFromHorarios(ent, sa, vol, sex) {
  const iso = (dt) => {
    const s = pontoHorarioParaSqlStringBrasil(dt);
    return s ? s.replace(' ', 'T') : null;
  };
  if (ent == null) return '[]';
  const e = iso(ent);
  const a = sa != null ? iso(sa) : null;
  const v = vol != null ? iso(vol) : null;
  const x = sex != null ? iso(sex) : null;
  if (a == null) return JSON.stringify([{ e, s: null }]);
  if (v == null) return JSON.stringify([{ e, s: a }]);
  if (x == null) return JSON.stringify([{ e, s: a }, { e: v, s: null }]);
  return JSON.stringify([{ e, s: a }, { e: v, s: x }]);
}

/**
 * Sincroniza horários em dbo.PontoEletronicoDia a partir de JornadaTrechosJson (trechos).
 * Regra: 1º trecho = manhã (entrada + saída almoço); 2º = tarde (volta + saída expediente).
 * Um único trecho no dia = entrada + saída final (sem intervalo de almoço registrado).
 */
async function syncPontoEletronicoDiaHorarios(tx, funcionarioId, diaDate) {
  const rSeg = await new sql.Request(tx)
    .input('id', sql.Int, funcionarioId)
    .input('dia', sql.Date, diaDate)
    .query(`
      SELECT JornadaTrechosJson
      FROM dbo.PontoEletronicoDia
      WHERE FuncionarioId = @id AND Dia = @dia;
    `);

  const rawJson =
    rSeg.recordset?.length > 0 ? rsGet(rSeg.recordset[0], 'JornadaTrechosJson') : null;
  const parsed = parseJornadaTrechosJson(rawJson);
  const segs = parsed.map((seg) => ({
    EntradaEm: toSqlDateTime2OrNull(seg.e ? new Date(seg.e) : null),
    SaidaEm: toSqlDateTime2OrNull(seg.s ? new Date(seg.s) : null),
  }));
  let ent = null;
  let sa = null;
  let vol = null;
  let sex = null;
  if (segs.length === 1) {
    ent = toSqlDateTime2OrNull(rsGet(segs[0], 'EntradaEm') ?? null);
    sex = toSqlDateTime2OrNull(rsGet(segs[0], 'SaidaEm') ?? null);
  } else if (segs.length >= 2) {
    ent = toSqlDateTime2OrNull(rsGet(segs[0], 'EntradaEm') ?? null);
    sa = toSqlDateTime2OrNull(rsGet(segs[0], 'SaidaEm') ?? null);
    vol = toSqlDateTime2OrNull(rsGet(segs[1], 'EntradaEm') ?? null);
    const last = segs[segs.length - 1];
    sex = toSqlDateTime2OrNull(rsGet(last, 'SaidaEm') ?? null);
  }

  if (segs.length === 0) {
    await new sql.Request(tx)
      .input('fid', sql.Int, funcionarioId)
      .input('dia', sql.Date, diaDate)
      .query(`
        UPDATE dbo.PontoEletronicoDia
        SET
          EntradaEm = NULL,
          SaidaAlmocoEm = NULL,
          VoltaAlmocoEm = NULL,
          SaidaExpedienteEm = NULL
        WHERE FuncionarioId = @fid AND Dia = @dia;
      `);
    return;
  }

  await new sql.Request(tx)
    .input('fid', sql.Int, funcionarioId)
    .input('dia', sql.Date, diaDate)
    .input('ent', sql.DateTime2, ent)
    .input('sa', sql.DateTime2, sa)
    .input('vol', sql.DateTime2, vol)
    .input('sex', sql.DateTime2, sex)
    .query(`
      MERGE dbo.PontoEletronicoDia AS t
      USING (SELECT @fid AS FuncionarioId, @dia AS Dia) AS s
      ON t.FuncionarioId = s.FuncionarioId AND t.Dia = s.Dia
      WHEN MATCHED THEN
        UPDATE SET
          EntradaEm = @ent,
          SaidaAlmocoEm = @sa,
          VoltaAlmocoEm = @vol,
          SaidaExpedienteEm = @sex
      WHEN NOT MATCHED THEN
        INSERT (
          FuncionarioId,
          Dia,
          EntradaEm,
          SaidaAlmocoEm,
          VoltaAlmocoEm,
          SaidaExpedienteEm,
          Falta,
          Atestado,
          Justificativa,
          Folga
        )
        VALUES (
          @fid,
          @dia,
          @ent,
          @sa,
          @vol,
          @sex,
          NULL,
          NULL,
          NULL,
          NULL
        );
    `);
}

/** Cache: se dbo.PontoEletronicoDia tem coluna PresencaDia (COALESCE na leitura do calendário). */
let cachePontoTemColunaPresencaDia = undefined;

/**
 * dbo.PontoEletronicoDia (FK Clientes) + colunas de batidas. Usada no PUT status-trabalho e no fallback de auth.
 * PresencaDia legada NOT NULL quebrava INSERT do MERGE sem valor — passa a aceitar NULL.
 */
async function ensurePontoEletronicoDiaSchema(pool) {
  await pool.request().query(`
        IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.PontoEletronicoDia (
            FuncionarioId INT NOT NULL,
            Dia DATE NOT NULL,
            Falta CHAR(1) NULL,
            Atestado CHAR(1) NULL,
            Folga CHAR(1) NULL,
            Justificativa NVARCHAR(2000) NULL,
            EntradaEm DATETIME2(0) NULL,
            SaidaAlmocoEm DATETIME2(0) NULL,
            VoltaAlmocoEm DATETIME2(0) NULL,
            SaidaExpedienteEm DATETIME2(0) NULL,
            CONSTRAINT PK_PontoEletronicoDia PRIMARY KEY (FuncionarioId, Dia),
            CONSTRAINT FK_PontoEletronicoDia_Clientes
              FOREIGN KEY (FuncionarioId) REFERENCES dbo.Clientes(Id) ON DELETE CASCADE,
            CONSTRAINT CK_PontoEletronicoDia_Falta CHECK (Falta IS NULL OR Falta = N'S'),
            CONSTRAINT CK_PontoEletronicoDia_Atest CHECK (Atestado IS NULL OR Atestado = N'S'),
            CONSTRAINT CK_PontoEletronicoDia_Folga CHECK (Folga IS NULL OR Folga = N'S')
          );
        END;
      `);
  await pool.request().query(`
        IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NOT NULL
        BEGIN
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'EntradaEm') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD EntradaEm DATETIME2(0) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'SaidaAlmocoEm') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD SaidaAlmocoEm DATETIME2(0) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'VoltaAlmocoEm') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD VoltaAlmocoEm DATETIME2(0) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'SaidaExpedienteEm') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD SaidaExpedienteEm DATETIME2(0) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'Folga') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD Folga CHAR(1) NULL
              CONSTRAINT CK_PontoEletronicoDia_Folga_Mig CHECK (Folga IS NULL OR Folga = N'S');
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'AtualizadoEm') IS NOT NULL
          BEGIN
            DECLARE @dcPed2 sysname;
            SELECT @dcPed2 = dc.name
            FROM sys.default_constraints dc
            INNER JOIN sys.columns c
              ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
            WHERE dc.parent_object_id = OBJECT_ID('dbo.PontoEletronicoDia')
              AND c.name = N'AtualizadoEm';
            IF @dcPed2 IS NOT NULL
            BEGIN
              DECLARE @sqlPed2 NVARCHAR(400) =
                N'ALTER TABLE dbo.PontoEletronicoDia DROP CONSTRAINT ' + QUOTENAME(@dcPed2);
              EXEC sp_executesql @sqlPed2;
            END;
            ALTER TABLE dbo.PontoEletronicoDia DROP COLUMN AtualizadoEm;
          END;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'AtestadoImagem') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD AtestadoImagem NVARCHAR(MAX) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'JornadaTrechosJson') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD JornadaTrechosJson NVARCHAR(MAX) NULL;
          IF COL_LENGTH('dbo.PontoEletronicoDia', 'PresencaDia') IS NULL
            ALTER TABLE dbo.PontoEletronicoDia ADD PresencaDia TINYINT NULL;
        END;
      `);
  try {
    await pool.request().query(`
        IF OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NOT NULL
          AND COL_LENGTH('dbo.PontoEletronicoDia', 'PresencaDia') IS NOT NULL
        ALTER TABLE dbo.PontoEletronicoDia ALTER COLUMN PresencaDia TINYINT NULL;
      `);
  } catch (e) {
    console.warn('PontoEletronicoDia PresencaDia NULL:', e?.message || e);
  }
  cachePontoTemColunaPresencaDia = undefined;
}

/**
 * Migra dbo.FuncionarioPresencaDia e dbo.PontoEletronicoJornada para dbo.PontoEletronicoDia e remove as tabelas legadas.
 */
async function migratePresencaEJornadaLegadoParaPontoEletronicoDia(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.FuncionarioPresencaDia', 'U') IS NOT NULL
    BEGIN
      MERGE dbo.PontoEletronicoDia AS t
      USING dbo.FuncionarioPresencaDia AS s
      ON t.FuncionarioId = s.FuncionarioId AND t.Dia = s.Dia
      WHEN MATCHED THEN
        UPDATE SET
          EntradaEm = CASE
            WHEN s.Situacao = 1 AND t.EntradaEm IS NULL
              THEN CAST(CONVERT(VARCHAR(10), s.Dia, 23) + N'T12:00:00' AS DATETIME2(0))
            ELSE t.EntradaEm END
      WHEN NOT MATCHED THEN
        INSERT (FuncionarioId, Dia, Falta, Atestado, Folga, Justificativa, EntradaEm)
        VALUES (
          s.FuncionarioId,
          s.Dia,
          NULL,
          NULL,
          NULL,
          NULL,
          CASE
            WHEN s.Situacao = 1
              THEN CAST(CONVERT(VARCHAR(10), s.Dia, 23) + N'T12:00:00' AS DATETIME2(0))
            ELSE NULL END
        );
      DROP TABLE dbo.FuncionarioPresencaDia;
    END
  `);

  const chkJ = await pool.request().query(`SELECT OBJECT_ID('dbo.PontoEletronicoJornada', 'U') AS oid;`);
  if (!chkJ.recordset?.[0]?.oid) return;

  const rows = await pool.request().query(`
    SELECT FuncionarioId, Id, EntradaEm, SaidaEm
    FROM dbo.PontoEletronicoJornada
    ORDER BY FuncionarioId, Id;
  `);
  const byKey = new Map();
  for (const row of rows.recordset || []) {
    const fid = Number(rsGet(row, 'FuncionarioId'));
    const ent = rsGet(row, 'EntradaEm');
    const sai = rsGet(row, 'SaidaEm');
    let diaDate = null;
    if (ent instanceof Date && !Number.isNaN(ent.getTime())) {
      diaDate = new Date(ent.getFullYear(), ent.getMonth(), ent.getDate());
    } else if (sai instanceof Date && !Number.isNaN(sai.getTime())) {
      diaDate = new Date(sai.getFullYear(), sai.getMonth(), sai.getDate());
    } else {
      continue;
    }
    const diaStr = diaDate.toISOString().slice(0, 10);
    const key = `${fid}|${diaStr}`;
    if (!byKey.has(key)) byKey.set(key, []);
    const eIso = ent instanceof Date && !Number.isNaN(ent.getTime()) ? ent.toISOString() : null;
    const sIso = sai instanceof Date && !Number.isNaN(sai.getTime()) ? sai.toISOString() : null;
    byKey.get(key).push({ e: eIso, s: sIso });
  }

  for (const [key, segArr] of byKey) {
    const [fidStr, diaStr] = key.split('|');
    const json = serializeJornadaTrechos(segArr);
    await pool
      .request()
      .input('fid', sql.Int, Number(fidStr))
      .input('dia', sql.Date, new Date(`${diaStr}T12:00:00`))
      .input('json', sql.NVarChar(sql.MAX), json)
      .query(`
        MERGE dbo.PontoEletronicoDia AS t
        USING (SELECT @fid AS FuncionarioId, @dia AS Dia) AS s
        ON t.FuncionarioId = s.FuncionarioId AND t.Dia = s.Dia
        WHEN MATCHED THEN
          UPDATE SET JornadaTrechosJson = @json
        WHEN NOT MATCHED THEN
          INSERT (FuncionarioId, Dia, JornadaTrechosJson, Falta, Atestado, Folga, Justificativa)
          VALUES (@fid, @dia, @json, NULL, NULL, NULL, NULL);
      `);
  }

  for (const key of byKey.keys()) {
    const [fidStr, diaStr] = key.split('|');
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await syncPontoEletronicoDiaHorarios(tx, Number(fidStr), new Date(`${diaStr}T12:00:00`));
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  await pool.request().query(`
    IF OBJECT_ID('dbo.PontoEletronicoJornada', 'U') IS NOT NULL
      DROP TABLE dbo.PontoEletronicoJornada;
  `);
}

/**
 * Gestor da escala vendo subordinado mesmo setor + hierarquia.
 * @returns {{ ok: true, viewerCargo: string, viewerSetor: string } | { ok: false, status: number, error: string }}
 */
async function validarGestorPodeVerColaboradorEquipe(pool, viewerId, colaboradorId) {
  if (!Number.isInteger(viewerId) || viewerId <= 0) {
    return { ok: false, status: 400, error: 'Cliente inválido.' };
  }
  if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) {
    return { ok: false, status: 400, error: 'colaboradorId inválido.' };
  }
  if (colaboradorId === viewerId) {
    return { ok: false, status: 400, error: 'Colaborador inválido.' };
  }

  const viewerRs = await pool
    .request()
    .input('id', sql.Int, viewerId)
    .query(`
      SELECT
        c.Funcionario AS ClienteFuncionario,
        f.Setor,
        f.Cargo,
        CAST(ISNULL(f.Ativos, 1) AS INT) AS Ativos
      FROM dbo.Clientes c
      LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
      WHERE c.Id = @id AND c.Ativo = 1;
    `);

  if (!viewerRs.recordset?.length) {
    return { ok: false, status: 404, error: 'Cliente não encontrado.' };
  }

  const vRow = viewerRs.recordset[0];
  if (!sqlBitIsOne(rsGet(vRow, 'ClienteFuncionario'))) {
    return { ok: false, status: 403, error: 'Apenas cadastros de funcionário podem consultar a equipe.' };
  }

  const viewerCargo = rsStr(vRow, 'Cargo');
  const viewerSetor = rsStr(vRow, 'Setor');
  const viewerAtivo = sqlFuncionarioEstaAtivo(rsGet(vRow, 'Ativos'));

  if (!viewerCargo.trim() || !viewerSetor.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'Complete setor e cargo nas configurações antes de consultar a equipe.',
    };
  }

  if (!viewerAtivo || !podeAcessarEscalaTrabalho(viewerCargo)) {
    return { ok: false, status: 403, error: 'Sem permissão para consultar a equipe.' };
  }

  const colabRs = await pool
    .request()
    .input('colabId', sql.Int, colaboradorId)
    .input('setor', sql.NVarChar(80), viewerSetor.trim())
    .query(`
      SELECT f.Cargo
      FROM dbo.Funcionarios f
      INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId
      WHERE f.FuncionarioId = @colabId
        AND ISNULL(f.Ativos, 1) = 1
        AND c.Ativo = 1
        AND LTRIM(RTRIM(ISNULL(f.Setor, N''))) COLLATE Latin1_General_CI_AI =
            LTRIM(RTRIM(@setor)) COLLATE Latin1_General_CI_AI;
    `);

  if (!colabRs.recordset?.length) {
    return { ok: false, status: 403, error: 'Colaborador não encontrado ou fora do seu setor.' };
  }

  const colCargo = rsStr(colabRs.recordset[0], 'Cargo');
  const viewerRankEquipe = cargoHierarchyRank(viewerCargo);
  if (viewerRankEquipe < 15) {
    return {
      ok: false,
      status: 403,
      error: 'Apenas a sua própria escala está disponível para o seu cargo.',
    };
  }
  if (!colaboradorEhSubordinadoDoCargo(viewerCargo, colCargo)) {
    return { ok: false, status: 403, error: 'Sem permissão para ver este colaborador.' };
  }

  return { ok: true, viewerCargo, viewerSetor: viewerSetor.trim() };
}

/** Catálogo de cargos (tabela CadastroCargo): coordenador + gerente. */
async function validarGestorCatalogoCargos(pool, viewerId) {
  if (!Number.isInteger(viewerId) || viewerId <= 0) {
    return { ok: false, status: 400, error: 'Cliente inválido.' };
  }
  const viewerRs = await pool
    .request()
    .input('id', sql.Int, viewerId)
    .query(`
      SELECT c.Funcionario AS ClienteFuncionario, f.Cargo, f.Ativos
      FROM dbo.Clientes c
      LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
      WHERE c.Id = @id AND c.Ativo = 1;
    `);
  if (!viewerRs.recordset?.length) {
    return { ok: false, status: 404, error: 'Cliente não encontrado.' };
  }
  const row = viewerRs.recordset[0];
  if (Number(rsGet(row, 'ClienteFuncionario') || 0) !== 1) {
    return { ok: false, status: 403, error: 'Apenas funcionários podem acessar o catálogo de cargos.' };
  }
  if (Number(rsGet(row, 'Ativos') || 0) !== 1) {
    return { ok: false, status: 403, error: 'Funcionário inativo.' };
  }
  const cargo = rsStr(row, 'Cargo');
  if (!cargo.trim()) {
    return { ok: false, status: 400, error: 'Complete o cargo no cadastro.' };
  }
  if (!podeGerirCatalogoDeCargos(cargo)) {
    return {
      ok: false,
      status: 403,
      error: 'Somente coordenadores e gerentes podem gerenciar o catálogo de cargos.',
    };
  }
  return { ok: true };
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

/**
 * ODBC/msnodesqlv8 pode enviar o texto do request de forma que o SQL Server exija
 * que CREATE TRIGGER seja a 1ª instrução do lote. sp_executesql isola o DDL num batch interno.
 */
async function execDdlInOwnBatch(pool, ddl) {
  await pool.request().input('__ddl', sql.NVarChar(sql.MAX), ddl).query('EXEC sp_executesql @__ddl');
}

const DDL_TRIGGER_TR_CLIENTES_SYNC = `
CREATE TRIGGER dbo.TR_Clientes_SyncFuncionarios
ON dbo.Clientes
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  DELETE f
  FROM dbo.Funcionarios f
  INNER JOIN inserted i ON i.Id = f.FuncionarioId
  WHERE i.Funcionario = 0;
  INSERT INTO dbo.Funcionarios (FuncionarioId, Ativos, DataInicio, DataDesligamento)
  SELECT i.Id, 1, SYSDATETIME(), NULL
  FROM inserted i
  WHERE i.Funcionario = 1
    AND NOT EXISTS (SELECT 1 FROM dbo.Funcionarios f2 WHERE f2.FuncionarioId = i.Id);
END
`.trim();

const DDL_TRIGGER_FUNC_NIVEL_CARGO = `
CREATE TRIGGER dbo.TR_Funcionarios_NivelPorCargo
ON dbo.Funcionarios
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE f
  SET f.Nivel = NULL
  FROM dbo.Funcionarios f
  INNER JOIN inserted i ON i.Id = f.Id
  WHERE f.Nivel IS NOT NULL
    AND i.Cargo IS NOT NULL
    AND (
      i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%estagi%'
      OR (
        i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%auxiliar%'
        AND LTRIM(RTRIM(i.Cargo)) COLLATE Latin1_General_CI_AI <> N'Auxiliar de Operações'
      )
      OR i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%ajudante%'
      OR (
        i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%encarregad%'
        AND i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%limpeza%'
      )
      OR (
        (
          i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%lider%'
          OR i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%líder%'
        )
        AND i.Cargo COLLATE Latin1_General_CI_AI LIKE N'%higieniz%'
      )
    );
END
`.trim();

/**
 * Colunas em Clientes + Enderecos + tabela Funcionarios (para JOIN no login).
 * Usado no início de ensureDbCompat e como fallback se o restante da migração falhar.
 */
async function ensureAuthSchemaMinimo(pool) {
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
        IF COL_LENGTH('dbo.Clientes', 'Funcionario') IS NULL
          ALTER TABLE dbo.Clientes ADD Funcionario BIT NOT NULL
            CONSTRAINT DF_Clientes_Funcionario_Api DEFAULT (0);

        /* Login/cadastro: bases antigas sem clientes_colunas_extras.sql falhavam no UPDATE/SELECT. */
        IF COL_LENGTH('dbo.Clientes', 'AtualizadoEm') IS NULL
          ALTER TABLE dbo.Clientes ADD AtualizadoEm DATETIME2(0) NULL;
        IF COL_LENGTH('dbo.Clientes', 'UltimoLoginEm') IS NULL
          ALTER TABLE dbo.Clientes ADD UltimoLoginEm DATETIME2(0) NULL;
        IF COL_LENGTH('dbo.Clientes', 'CriadoEm') IS NULL
          ALTER TABLE dbo.Clientes ADD CriadoEm DATETIME2(0) NOT NULL
            CONSTRAINT DF_Clientes_CriadoEm_ApiCompat DEFAULT (SYSDATETIME());
        IF COL_LENGTH('dbo.Clientes', 'Ativo') IS NULL
          ALTER TABLE dbo.Clientes ADD Ativo BIT NOT NULL
            CONSTRAINT DF_Clientes_Ativo_ApiCompat DEFAULT (1);
        IF COL_LENGTH('dbo.Clientes', 'DataNascimento') IS NULL
          ALTER TABLE dbo.Clientes ADD DataNascimento DATE NULL;
        IF COL_LENGTH('dbo.Clientes', 'Documento') IS NULL
          ALTER TABLE dbo.Clientes ADD Documento NVARCHAR(50) NULL;

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
  await pool.request().query(`
        IF OBJECT_ID('dbo.Funcionarios', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.Funcionarios (
            Id INT IDENTITY(1,1) NOT NULL
              CONSTRAINT PK_Funcionarios_Api PRIMARY KEY,
            FuncionarioId INT NOT NULL,
            Ativos BIT NOT NULL
              CONSTRAINT DF_Funcionarios_Ativos_Api DEFAULT (1),
            Setor NVARCHAR(80) NULL,
            Cargo NVARCHAR(80) NULL,
            Nivel NVARCHAR(20) NULL,
            DataInicio DATETIME2(0) NOT NULL
              CONSTRAINT DF_Funcionarios_DataInicio_Api DEFAULT (SYSDATETIME()),
            DataDesligamento DATETIME2(0) NULL,
            CONSTRAINT FK_Funcionarios_Clientes_Api
              FOREIGN KEY (FuncionarioId) REFERENCES dbo.Clientes(Id) ON DELETE CASCADE,
            CONSTRAINT UX_Funcionarios_FuncionarioId_Api UNIQUE (FuncionarioId)
          );
        END;
      `);
  /* Obrigatório para PUT /status-trabalho quando só roda o fallback (migração grande falhou). */
  await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'StatusTrabalho') IS NULL
          ALTER TABLE dbo.Funcionarios ADD StatusTrabalho TINYINT NOT NULL
            CONSTRAINT DF_Funcionarios_StatusTrabalho_Min DEFAULT (0);
      `);
  await ensurePontoEletronicoDiaSchema(pool);
}

/** Migração completa pode falhar (dados legados); login/cadastro/Google precisam só do schema mínimo. */
async function ensureDbCompatOrFallbackAuth() {
  try {
    await ensureDbCompat();
  } catch (e) {
    console.error('ensureDbCompat (fallback auth):', e?.message || e);
    const pool = await getPool();
    await ensureAuthSchemaMinimo(pool);
  }
}

let dbCompatReadyPromise = null;
function ensureDbCompat() {
  if (!dbCompatReadyPromise) {
    dbCompatReadyPromise = (async () => {
      const pool = await getPool();
      await ensureAuthSchemaMinimo(pool);
      await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'DataInicio') IS NULL
          AND COL_LENGTH('dbo.Funcionarios', 'CriadoEm') IS NOT NULL
          EXEC sp_rename 'dbo.Funcionarios.CriadoEm', 'DataInicio', 'COLUMN';
      `);
      await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'DataDesligamento') IS NULL
          AND COL_LENGTH('dbo.Funcionarios', 'AtualizadoEm') IS NOT NULL
          EXEC sp_rename 'dbo.Funcionarios.AtualizadoEm', 'DataDesligamento', 'COLUMN';
      `);
      await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'DataDesligamento') IS NOT NULL
        BEGIN
          ALTER TABLE dbo.Funcionarios ALTER COLUMN DataDesligamento DATETIME2(0) NULL;
          DECLARE @fdc sysname;
          SELECT @fdc = dc.name
          FROM sys.default_constraints dc
          INNER JOIN sys.columns c
            ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
          WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
            AND c.name = 'DataDesligamento';
          IF @fdc IS NOT NULL
          BEGIN
            DECLARE @sql_drop_fdc NVARCHAR(400);
            SET @sql_drop_fdc = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@fdc);
            EXEC(@sql_drop_fdc);
          END
        END
      `);
      await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'Ativos') IS NULL
          ALTER TABLE dbo.Funcionarios ADD Ativos BIT NOT NULL
            CONSTRAINT DF_Funcionarios_Ativos_Api_Compat DEFAULT (1);
        IF COL_LENGTH('dbo.Funcionarios', 'Nome') IS NOT NULL
          ALTER TABLE dbo.Funcionarios DROP COLUMN Nome;
        IF COL_LENGTH('dbo.Funcionarios', 'Setor') IS NULL
          ALTER TABLE dbo.Funcionarios ADD Setor NVARCHAR(80) NULL;
        IF COL_LENGTH('dbo.Funcionarios', 'Cargo') IS NULL
          ALTER TABLE dbo.Funcionarios ADD Cargo NVARCHAR(80) NULL;
        IF COL_LENGTH('dbo.Funcionarios', 'Nivel') IS NULL
          ALTER TABLE dbo.Funcionarios ADD Nivel NVARCHAR(20) NULL;
        IF COL_LENGTH('dbo.Funcionarios', 'FuncionarioId') IS NULL
          AND COL_LENGTH('dbo.Funcionarios', 'ClienteId') IS NOT NULL
          EXEC sp_rename 'dbo.Funcionarios.ClienteId', 'FuncionarioId', 'COLUMN';
        UPDATE dbo.Funcionarios
        SET Setor = N'Administrativo'
        WHERE Setor IS NOT NULL
          AND LTRIM(RTRIM(Setor)) COLLATE Latin1_General_CI_AI = N'Gerencia';
        IF COL_LENGTH('dbo.Funcionarios', 'StatusTrabalho') IS NULL
          ALTER TABLE dbo.Funcionarios ADD StatusTrabalho TINYINT NOT NULL
            CONSTRAINT DF_Funcionarios_StatusTrabalho_Api DEFAULT (0);
      `);
      try {
        await pool.request().query(`
        IF COL_LENGTH('dbo.Funcionarios', 'StatusTrabalho') IS NOT NULL
        BEGIN
          /* Legado: script manual usava 2 = fora; API usa 0 = Não, 1 = Sim. */
          UPDATE dbo.Funcionarios SET StatusTrabalho = 0 WHERE StatusTrabalho NOT IN (0, 1);
          DECLARE @dcSt sysname;
          SELECT @dcSt = dc.name
          FROM sys.default_constraints dc
          INNER JOIN sys.columns c
            ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
          WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
            AND c.name = N'StatusTrabalho';
          IF @dcSt IS NOT NULL
          BEGIN
            DECLARE @dropDcSt NVARCHAR(400);
            SET @dropDcSt = N'ALTER TABLE dbo.Funcionarios DROP CONSTRAINT ' + QUOTENAME(@dcSt);
            EXEC sp_executesql @dropDcSt;
          END;
          IF NOT EXISTS (
            SELECT 1
            FROM sys.default_constraints dc
            INNER JOIN sys.columns c
              ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
            WHERE dc.parent_object_id = OBJECT_ID('dbo.Funcionarios')
              AND c.name = N'StatusTrabalho'
          )
            ALTER TABLE dbo.Funcionarios
              ADD CONSTRAINT DF_Funcionarios_StatusTrabalho_0 DEFAULT (0) FOR StatusTrabalho;
          IF NOT EXISTS (
            SELECT 1 FROM sys.check_constraints
            WHERE parent_object_id = OBJECT_ID('dbo.Funcionarios')
              AND name = N'CHK_Funcionarios_StatusTrabalho_01'
          )
            ALTER TABLE dbo.Funcionarios
              ADD CONSTRAINT CHK_Funcionarios_StatusTrabalho_01 CHECK (StatusTrabalho IN (0, 1));
        END;
      `);
      } catch (stErr) {
        console.error('Funcionarios StatusTrabalho constraints:', stErr?.message || stErr);
      }
      await ensurePontoEletronicoDiaSchema(pool);
      try {
        await migratePresencaEJornadaLegadoParaPontoEletronicoDia(pool);
      } catch (migErr) {
        /* Migração legada não pode bloquear login nem o restante do schema. */
        console.error('migratePresencaEJornadaLegadoParaPontoEletronicoDia:', migErr?.message || migErr);
      }
      await pool.request().query(`
        IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.CadastroCargo (
            Id INT IDENTITY(1,1) NOT NULL
              CONSTRAINT PK_CadastroCargo PRIMARY KEY,
            Nome NVARCHAR(120) NOT NULL,
            Descricao NVARCHAR(500) NULL,
            Ativo BIT NOT NULL
              CONSTRAINT DF_CadastroCargo_Ativo DEFAULT (1),
            PadraoSistema BIT NOT NULL
              CONSTRAINT DF_CadastroCargo_PadraoSis DEFAULT (0),
            OrdemExibicao INT NULL,
            Setor NVARCHAR(80) NULL,
            Nivel NVARCHAR(20) NULL,
            CONSTRAINT UQ_CadastroCargo_Nome UNIQUE (Nome)
          );
          CREATE INDEX IX_CadastroCargo_Ativo_Ordem
            ON dbo.CadastroCargo (Ativo, OrdemExibicao, Nome);
        END;
      `);
      await pool.request().query(`
        IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NOT NULL
        BEGIN
          IF COL_LENGTH('dbo.CadastroCargo', 'Setor') IS NULL
            ALTER TABLE dbo.CadastroCargo ADD Setor NVARCHAR(80) NULL;
          IF COL_LENGTH('dbo.CadastroCargo', 'Nivel') IS NULL
            ALTER TABLE dbo.CadastroCargo ADD Nivel NVARCHAR(20) NULL;
          IF COL_LENGTH('dbo.CadastroCargo', 'CriadoEm') IS NOT NULL
          BEGIN
            DECLARE @dcCriado sysname;
            SELECT @dcCriado = dc.name
            FROM sys.default_constraints dc
            INNER JOIN sys.columns c
              ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
            WHERE dc.parent_object_id = OBJECT_ID('dbo.CadastroCargo')
              AND c.name = N'CriadoEm';
            IF @dcCriado IS NOT NULL
            BEGIN
              DECLARE @sqlDropCriado NVARCHAR(400) =
                N'ALTER TABLE dbo.CadastroCargo DROP CONSTRAINT ' + QUOTENAME(@dcCriado);
              EXEC sp_executesql @sqlDropCriado;
            END;
            ALTER TABLE dbo.CadastroCargo DROP COLUMN CriadoEm;
          END;
          IF COL_LENGTH('dbo.CadastroCargo', 'AtualizadoEm') IS NOT NULL
            ALTER TABLE dbo.CadastroCargo DROP COLUMN AtualizadoEm;
        END;
      `);
      try {
        /* Migração catálogo + Funcionarios: renomeações e retiradas (antes do MERGE seed). */
        await pool.request().query(`
        IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NOT NULL
          AND OBJECT_ID('dbo.Funcionarios', 'U') IS NOT NULL
        BEGIN
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
        END;
      `);
        await pool.request().query(`
        IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NOT NULL
        BEGIN
          /* OrdemExibicao menor = mais alto na hierarquia. Setor alinhado ao nome do cargo. */
          ;WITH final AS (
            SELECT Nome, OrdemExibicao, Setor
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
            ) AS v(Nome, OrdemExibicao, Setor)
          )
          MERGE dbo.CadastroCargo AS t
          USING final AS s
          ON LTRIM(RTRIM(t.Nome)) COLLATE Latin1_General_CI_AI =
             s.Nome COLLATE Latin1_General_CI_AI
          WHEN MATCHED THEN
            UPDATE SET
              t.OrdemExibicao = s.OrdemExibicao,
              t.Setor = s.Setor
          WHEN NOT MATCHED THEN
            INSERT (Nome, Ativo, PadraoSistema, OrdemExibicao, Setor)
            VALUES (s.Nome, 1, 1, s.OrdemExibicao, s.Setor);
        END;
      `);
        await pool.request().query(`
        IF OBJECT_ID('dbo.CadastroCargo', 'U') IS NOT NULL
          AND OBJECT_ID('dbo.Funcionarios', 'U') IS NOT NULL
        BEGIN
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
          BEGIN
            DELETE FROM dbo.CadastroCargo
            WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider';
          END
          ELSE IF EXISTS (
            SELECT 1 FROM dbo.CadastroCargo
            WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider'
          )
          BEGIN
            UPDATE dbo.CadastroCargo
            SET Nome = N'Líder de Alimentos'
            WHERE LTRIM(RTRIM(Nome)) COLLATE Latin1_General_CS_AS = N'Lider';
          END
        END;
      `);
      } catch (cargoErr) {
        console.error('CadastroCargo seed / Líder:', cargoErr?.message || cargoErr);
      }
      try {
        await pool.request().query(`
        IF OBJECT_ID('dbo.TR_Clientes_SyncFuncionarios', 'TR') IS NOT NULL
          DROP TRIGGER dbo.TR_Clientes_SyncFuncionarios;
      `);
        await execDdlInOwnBatch(pool, DDL_TRIGGER_TR_CLIENTES_SYNC);
      } catch (trErr) {
        console.error('TR_Clientes_SyncFuncionarios:', trErr?.message || trErr);
      }
      try {
        await pool.request().query(`
        IF OBJECT_ID('dbo.TR_Funcionarios_NivelPorCargo', 'TR') IS NOT NULL
          DROP TRIGGER dbo.TR_Funcionarios_NivelPorCargo;
      `);
        await execDdlInOwnBatch(pool, DDL_TRIGGER_FUNC_NIVEL_CARGO);
      } catch (tr2Err) {
        console.error('TR_Funcionarios_NivelPorCargo:', tr2Err?.message || tr2Err);
      }
    })().catch((err) => {
      // Se falhar uma vez (ex.: banco temporariamente indisponível),
      // permite nova tentativa nas próximas requisições.
      dbCompatReadyPromise = null;
      throw err;
    });
  }
  return dbCompatReadyPromise;
}

async function pontoEletronicoDiaTemColunaPresencaDia(pool) {
  if (cachePontoTemColunaPresencaDia !== undefined) return cachePontoTemColunaPresencaDia;
  try {
    const r = await pool.request().query(`
      SELECT CASE
        WHEN OBJECT_ID('dbo.PontoEletronicoDia', 'U') IS NULL THEN 0
        ELSE CONVERT(int, COL_LENGTH('dbo.PontoEletronicoDia', 'PresencaDia'))
      END AS n;
    `);
    const n = Number(rsGet(r.recordset?.[0], 'n'));
    cachePontoTemColunaPresencaDia = Number.isFinite(n) && n > 0;
  } catch {
    cachePontoTemColunaPresencaDia = false;
  }
  return cachePontoTemColunaPresencaDia;
}

/**
 * Calendário “trabalhou / falta” por dia (mapa mensal). Não confundir com dbo.Funcionarios.StatusTrabalho:
 * esse campo é o Sim/Não **atual**, não o histórico dia a dia.
 * Antes: dbo.PontoEletronicoDia.PresencaDia (0/1). Agora: Falta, Folga e horários; COALESCE se a coluna legada existir.
 */
function sqlFragmentPresencaSituacaoCalendario(temColunaPresencaDia) {
  /* Verde automático: EntradaEm. PresencaDia (0/1) = ajuste manual do gestor no calendário. */
  const automatico = `
CASE
  WHEN Falta = N'S' THEN CAST(0 AS TINYINT)
  WHEN Folga = N'S' THEN NULL
  WHEN EntradaEm IS NOT NULL THEN CAST(1 AS TINYINT)
  ELSE NULL
END`.trim();
  const situacao = temColunaPresencaDia
    ? `COALESCE(
        CASE WHEN [PresencaDia] IS NOT NULL THEN CAST([PresencaDia] AS TINYINT) ELSE NULL END,
        ${automatico}
      )`
    : automatico;
  const temRegistroRelevante = temColunaPresencaDia
    ? `(Falta = N'S' OR Folga = N'S' OR EntradaEm IS NOT NULL OR SaidaAlmocoEm IS NOT NULL OR VoltaAlmocoEm IS NOT NULL OR SaidaExpedienteEm IS NOT NULL OR [PresencaDia] IS NOT NULL)`
    : `(Falta = N'S' OR Folga = N'S' OR EntradaEm IS NOT NULL OR SaidaAlmocoEm IS NOT NULL OR VoltaAlmocoEm IS NOT NULL OR SaidaExpedienteEm IS NOT NULL)`;
  return { situacao, temRegistroRelevante };
}

/** Seg–Sáb: dias em que ausência sem registro vira falta automática (domingo não). */
function diaEsperadoExpedienteParqueFromIso(diaStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(diaStr);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  const wd = dt.getDay();
  return wd >= 1 && wd <= 6;
}

/**
 * Regras após ler PontoEletronicoDia:
 * - Registro sem EntradaEm mas com atestado / imagem / justificativa → exibir como Folga (F), não falta.
 * - Dia útil já passou, sem linha no dia → falta automática (0).
 * - Dia útil já passou, linha sem entrada e sem folga/justificativa → falta automática (0).
 * Não altera dias futuros nem o dia atual (até virar “ontem”).
 */
function aplicarRegrasPresencaAutomaticaMes(year, month, hojeIso, presencaDias, diaDetalhes) {
  if (!presencaDias || typeof presencaDias !== 'object') return;
  const det = diaDetalhes && typeof diaDetalhes === 'object' ? diaDetalhes : {};
  const lastDay = new Date(year, month, 0).getDate();

  const temIndicioFolgaJustificada = (row) => {
    if (!row || typeof row !== 'object') return false;
    if (row.falta === 'S') return false;
    if (row.atestado === 'S') return true;
    const j = typeof row.justificativa === 'string' ? row.justificativa.trim() : '';
    if (j.length > 0) return true;
    const img = row.atestadoImagem;
    if (typeof img === 'string' && img.trim().length > 0) return true;
    return false;
  };

  const temEntrada = (row) => {
    if (!row || typeof row !== 'object') return false;
    const e = row.entradaEm;
    return typeof e === 'string' && e.length > 0;
  };

  /* 1) Folga derivada: registro sem batida de entrada mas com justificativa/atestado/imagem */
  for (const diaStr of Object.keys(det)) {
    const r = det[diaStr];
    if (temEntrada(r)) continue;
    if (r.falta === 'S') continue;
    if (!temIndicioFolgaJustificada(r)) continue;
    r.folga = 'S';
    if (presencaDias[diaStr] === 0) {
      delete presencaDias[diaStr];
    }
  }

  for (let day = 1; day <= lastDay; day++) {
    const diaStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (diaStr >= hojeIso) continue;
    if (!diaEsperadoExpedienteParqueFromIso(diaStr)) continue;

    const row = det[diaStr];
    if (row == null) {
      if (presencaDias[diaStr] !== 1) {
        presencaDias[diaStr] = 0;
      }
      continue;
    }

    if (temEntrada(row)) continue;
    if (row.falta === 'S') {
      presencaDias[diaStr] = 0;
      continue;
    }
    if (row.folga === 'S') {
      if (presencaDias[diaStr] === 0) delete presencaDias[diaStr];
      continue;
    }
    if (presencaDias[diaStr] === 1) continue;

    presencaDias[diaStr] = 0;
  }
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
    await ensureDbCompatOrFallbackAuth();
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
        `SELECT
           c.Id,
           c.Email,
           c.Telefone,
           c.SenhaHash,
           c.Nome,
           c.Sobrenome,
           c.Apelido,
           c.FotoPerfil,
           c.Funcionario,
           CASE
             WHEN ISNULL(c.Funcionario, 0) = 1 THEN ISNULL(f.Ativos, 0)
             ELSE 0
           END AS FuncionarioAtivo,
           CAST(ISNULL(f.StatusTrabalho, 0) AS TINYINT) AS StatusTrabalho
         FROM dbo.Clientes c
         LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
         WHERE c.Email = @email
           AND c.Ativo = 1`
      );

    if (existing.recordset.length === 0) {
      return res.status(404).json({ error: 'Este e-mail não está cadastrado' });
    }

    const cliente = existing.recordset[0];
    const senhaHash = rsGet(cliente, 'SenhaHash');
    if (senhaHash == null || String(senhaHash).trim() === '') {
      return res.status(401).json({
        error: 'Esta conta não tem senha cadastrada. Use entrar com Google ou cadastre uma senha.',
      });
    }
    let ok = false;
    try {
      ok = await bcrypt.compare(password, senhaHash);
    } catch (cmpErr) {
      console.error('bcrypt.compare:', cmpErr);
      return res.status(500).json({
        error: 'Erro ao validar senha no servidor.',
        detail: String(cmpErr?.message || cmpErr),
      });
    }
    if (!ok) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const clienteId = rsGet(cliente, 'Id');
    await atualizarAuditoriaLogin(pool, clienteId);

    return res.json({
      ok: true,
      cliente: clientePayload(cliente),
    });
  } catch (err) {
    console.error(err);
    const hint = sqlHealthUserHint(err);
    return res.status(500).json({
      error: 'Erro no servidor. Verifique a conexão com o banco.',
      detail: String(err?.message || err),
      ...(hint ? { hint } : {}),
    });
  }
});

/**
 * Cadastro completo (após informar que o e-mail não existia).
 */
app.post('/api/auth/cadastro', async (req, res) => {
  try {
    await ensureDbCompatOrFallbackAuth();
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
         VALUES (@nome, @sobrenome, @apelido, @email, @senhaHash, @dataNascimento, @telefone, @documento, SYSDATETIME(), SYSDATETIME());

         SELECT TOP 1
           Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil, Funcionario
         FROM dbo.Clientes
         WHERE Id = CAST(SCOPE_IDENTITY() AS INT);`
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
    await ensureDbCompatOrFallbackAuth();
    const idToken = req.body?.idToken;

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'Token do Google ausente.' });
    }

    const audiences = [GOOGLE_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
    if (audiences.length === 0) {
      return res.status(500).json({
        error: 'Configure GOOGLE_CLIENT_ID (Web) e/ou GOOGLE_ANDROID_CLIENT_ID/GOOGLE_IOS_CLIENT_ID no .env do backend.',
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
          `SELECT
             c.Id,
             c.Email,
             c.Telefone,
             c.Nome,
             c.Sobrenome,
             c.Apelido,
             c.FotoPerfil,
             c.Funcionario,
             CASE
               WHEN ISNULL(c.Funcionario, 0) = 1 THEN ISNULL(f.Ativos, 0)
               ELSE 0
             END AS FuncionarioAtivo,
             CAST(ISNULL(f.StatusTrabalho, 0) AS TINYINT) AS StatusTrabalho
           FROM dbo.AuthExterno a
           INNER JOIN dbo.Clientes c ON c.Id = a.ClienteId
           LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
           WHERE a.Provider = @provider AND a.ProviderUserId = @sub`
        );

      if (link.recordset.length > 0) {
        const row = link.recordset[0];
        const rowId = rsGet(row, 'Id');
        await atualizarAuditoriaLogin(pool, rowId, tx);
        await tx.commit();
        return res.json({
          ok: true,
          criado: false,
          cliente: clientePayload(row),
        });
      }

      const byEmail = await new sql.Request(tx)
        .input('email', sql.NVarChar(180), email)
        .query(
          `SELECT
             c.Id,
             c.Email,
             c.Telefone,
             c.Nome,
             c.Sobrenome,
             c.Apelido,
             c.FotoPerfil,
             c.Funcionario,
             CASE
               WHEN ISNULL(c.Funcionario, 0) = 1 THEN ISNULL(f.Ativos, 0)
               ELSE 0
             END AS FuncionarioAtivo,
             CAST(ISNULL(f.StatusTrabalho, 0) AS TINYINT) AS StatusTrabalho
           FROM dbo.Clientes c
           LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
           WHERE c.Email = @email`
        );

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
             VALUES (@nome, @sobrenome, @apelido, @email, @senhaHash, NULL, NULL, NULL, SYSDATETIME(), SYSDATETIME());

             SELECT TOP 1
               Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil, Funcionario
             FROM dbo.Clientes
             WHERE Id = CAST(SCOPE_IDENTITY() AS INT);`
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

      await atualizarAuditoriaLogin(pool, clienteId, tx);

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
    await ensureDbCompat();
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

    const emailOptRaw = String(req.body?.email || '').trim().toLowerCase();
    const emailUpdate = emailOptRaw.length > 0 ? emailOptRaw.slice(0, 180) : null;
    if (emailUpdate && !isValidEmail(emailUpdate)) {
      return res.status(400).json({ error: 'E-mail incorreto.' });
    }

    const pool = await getPool();
    if (emailUpdate) {
      const dup = await pool
        .request()
        .input('email', sql.NVarChar(180), emailUpdate)
        .input('id', sql.Int, clienteId)
        .query('SELECT TOP 1 Id FROM dbo.Clientes WHERE Email = @email AND Id <> @id');
      if (dup.recordset && dup.recordset.length > 0) {
        return res.status(409).json({ error: 'Este e-mail já está em uso por outra conta.' });
      }
    }

    const rqUp = pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('nome', sql.NVarChar(120), nome)
      .input('sobrenome', sql.NVarChar(120), sobrenome)
      .input('apelido', sql.NVarChar(120), apelido);

    const upd = emailUpdate
      ? await rqUp.input('email', sql.NVarChar(180), emailUpdate).query(`
          UPDATE dbo.Clientes
          SET Nome = @nome,
              Sobrenome = @sobrenome,
              Apelido = @apelido,
              Email = @email,
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @id AND Ativo = 1;
        `)
      : await rqUp.query(`
          UPDATE dbo.Clientes
          SET Nome = @nome,
              Sobrenome = @sobrenome,
              Apelido = @apelido,
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @id AND Ativo = 1;
        `);

    if (rowsAffectedFirst(upd) < 1) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const sel = await pool.request().input('id', sql.Int, clienteId).query(`
      SELECT TOP 1
        Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil
      FROM dbo.Clientes
      WHERE Id = @id AND Ativo = 1;
    `);
    if (!sel.recordset || sel.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(sel.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/:id/perfil-pessoal:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar informações pessoais.' });
  }
});

app.put('/api/clientes/perfil-pessoal', async (req, res) => {
  try {
    await ensureDbCompat();
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

    const emailUpdate =
      hasId && emailRaw.length > 0 ? emailRaw.slice(0, 180) : null;
    if (emailUpdate && !isValidEmail(emailUpdate)) {
      return res.status(400).json({ error: 'E-mail incorreto.' });
    }

    const pool = await getPool();
    const reqBase = pool
      .request()
      .input('nome', sql.NVarChar(120), nome)
      .input('sobrenome', sql.NVarChar(120), sobrenome)
      .input('apelido', sql.NVarChar(120), apelido);

    if (hasId && emailUpdate) {
      const dup = await pool
        .request()
        .input('email', sql.NVarChar(180), emailUpdate)
        .input('cid', sql.Int, id)
        .query('SELECT TOP 1 Id FROM dbo.Clientes WHERE Email = @email AND Id <> @cid');
      if (dup.recordset && dup.recordset.length > 0) {
        return res.status(409).json({ error: 'Este e-mail já está em uso por outra conta.' });
      }
    }

    let upd;
    if (hasId) {
      upd = emailUpdate
        ? await reqBase
            .input('id', sql.Int, id)
            .input('email', sql.NVarChar(180), emailUpdate)
            .query(`
              UPDATE dbo.Clientes
              SET Nome = @nome,
                  Sobrenome = @sobrenome,
                  Apelido = @apelido,
                  Email = @email,
                  AtualizadoEm = SYSDATETIME()
              WHERE Id = @id AND Ativo = 1;
            `)
        : await reqBase.input('id', sql.Int, id).query(`
            UPDATE dbo.Clientes
            SET Nome = @nome,
                Sobrenome = @sobrenome,
                Apelido = @apelido,
                AtualizadoEm = SYSDATETIME()
            WHERE Id = @id AND Ativo = 1;
          `);
    } else {
      upd = await reqBase.input('email', sql.NVarChar(180), emailRaw).query(`
        UPDATE dbo.Clientes
        SET Nome = @nome,
            Sobrenome = @sobrenome,
            Apelido = @apelido,
            AtualizadoEm = SYSDATETIME()
        WHERE Email = @email AND Ativo = 1;
      `);
    }

    if (rowsAffectedFirst(upd) < 1) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const sel = hasId
      ? await pool.request().input('id', sql.Int, id).query(`
          SELECT TOP 1
            Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil
          FROM dbo.Clientes
          WHERE Id = @id AND Ativo = 1;
        `)
      : await pool.request().input('email', sql.NVarChar(180), emailRaw).query(`
          SELECT TOP 1
            Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil
          FROM dbo.Clientes
          WHERE Email = @email AND Ativo = 1;
        `);

    if (!sel.recordset || sel.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(sel.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/perfil-pessoal:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao atualizar informações pessoais.' });
  }
});

app.put('/api/clientes/:id/contato', async (req, res) => {
  try {
    await ensureDbCompat();
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

    const upd = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('email', sql.NVarChar(180), emailRaw)
      .input('telefone', sql.NVarChar(20), telefone)
      .query(`
        UPDATE dbo.Clientes
        SET Email = @email,
            Telefone = @telefone,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @id AND Ativo = 1;
      `);

    if (rowsAffectedFirst(upd) < 1) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const sel = await pool.request().input('id', sql.Int, clienteId).query(`
      SELECT TOP 1
        Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil
      FROM dbo.Clientes
      WHERE Id = @id AND Ativo = 1;
    `);
    if (!sel.recordset || sel.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(sel.recordset[0]) });
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
    const upd = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .input('fotoPerfil', sql.NVarChar(sql.MAX), fotoPerfil)
      .query(`
        UPDATE dbo.Clientes
        SET FotoPerfil = @fotoPerfil,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @id AND Ativo = 1;
      `);
    if (rowsAffectedFirst(upd) < 1) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const sel = await pool.request().input('id', sql.Int, clienteId).query(`
      SELECT TOP 1
        Id, Email, Telefone, Nome, Sobrenome, Apelido, FotoPerfil
      FROM dbo.Clientes
      WHERE Id = @id AND Ativo = 1;
    `);
    if (!sel.recordset || sel.recordset.length === 0) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    return res.json({ ok: true, cliente: clientePayload(sel.recordset[0]) });
  } catch (err) {
    console.error('PUT /api/clientes/:id/foto:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao salvar foto de perfil.',
      detail: String(err?.message || err),
    });
  }
});

app.get('/api/funcionarios/:id/perfil', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    await ensureDbCompat();
    const pool = await getPool();
    const rowRs = await pool
      .request()
      .input('id', sql.Int, clienteId)
      .query(`
        SELECT
          c.Id,
          c.Funcionario,
          f.Ativos,
          f.Setor,
          f.Cargo,
          f.Nivel,
          ISNULL(f.StatusTrabalho, 0) AS StatusTrabalho
        FROM dbo.Clientes c
        LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
        WHERE c.Id = @id;
      `);
    if (!rowRs.recordset?.length) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const row = rowRs.recordset[0];
    return res.json({
      ok: true,
      perfil: {
        funcionario: Number(rsGet(row, 'Funcionario') || 0) === 1,
        ativo: Number(rsGet(row, 'Ativos') || 0) === 1,
        setor: rsStr(row, 'Setor'),
        cargo: rsStr(row, 'Cargo'),
        nivel: rsStr(row, 'Nivel'),
        statusTrabalho: normalizeStatusTrabalhoDb(rsGet(row, 'StatusTrabalho')),
        podeVerEscalaTrabalho: podeAcessarEscalaTrabalho(rsStr(row, 'Cargo')),
        podeGerirCatalogoCargos: podeGerirCatalogoDeCargos(rsStr(row, 'Cargo')),
      },
    });
  } catch (err) {
    console.error('GET /api/funcionarios/:id/perfil:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao carregar perfil de funcionário.' });
  }
});

/** Catálogo de cargos/funções (dbo.CadastroCargo). Leitura e inclusão — gerente/coordenador. */
app.get('/api/funcionarios/:id/cadastro-cargos', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    await ensureDbCompat();
    const pool = await getPool();
    const val = await validarGestorCatalogoCargos(pool, viewerId);
    if (!val.ok) {
      return res.status(val.status).json({ error: val.error });
    }
    const rs = await pool.request().query(`
      SELECT
        Id,
        Nome,
        Descricao,
        Ativo,
        PadraoSistema,
        OrdemExibicao,
        Setor,
        Nivel
      FROM dbo.CadastroCargo
      WHERE Ativo = 1
      ORDER BY
        CASE WHEN OrdemExibicao IS NULL THEN 1 ELSE 0 END,
        OrdemExibicao,
        Nome COLLATE Latin1_General_CI_AI;
    `);
    const cargos = (rs.recordset || []).map((r) => ({
      id: Number(rsGet(r, 'Id')),
      nome: rsStr(r, 'Nome'),
      descricao: rsStr(r, 'Descricao'),
      padraoSistema: Number(rsGet(r, 'PadraoSistema') || 0) === 1,
      ordemExibicao: rsGet(r, 'OrdemExibicao'),
      setor: rsStr(r, 'Setor'),
      nivel: rsStr(r, 'Nivel'),
    }));
    return res.json({ ok: true, cargos });
  } catch (err) {
    console.error('GET /api/funcionarios/:id/cadastro-cargos:', err?.message || err);
    return res.status(500).json({ error: 'Não foi possível carregar o catálogo de cargos.' });
  }
});

app.post('/api/funcionarios/:id/cadastro-cargos', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    const nomeRaw = String(req.body?.nome || '').trim();
    const descRaw = String(req.body?.descricao || '').trim().slice(0, 500);
    const setorRaw = String(req.body?.setor || '').trim().slice(0, 80);
    const nivelRaw = String(req.body?.nivel || '').trim().slice(0, 20);
    if (nomeRaw.length < 2 || nomeRaw.length > 120) {
      return res.status(400).json({
        error: 'O nome deve ter entre 2 e 120 caracteres.',
        field: 'nome',
      });
    }
    if (setorRaw.length < 1) {
      return res.status(400).json({ error: 'O setor é obrigatório.', field: 'setor' });
    }
    const subId = Number(req.body?.subordinadoACargoId);
    if (!Number.isInteger(subId) || subId <= 0) {
      return res.status(400).json({
        error: 'Selecione o cargo superior imediato.',
        field: 'subordinadoACargoId',
      });
    }
    await ensureDbCompat();
    const pool = await getPool();
    const val = await validarGestorCatalogoCargos(pool, viewerId);
    if (!val.ok) {
      return res.status(val.status).json({ error: val.error });
    }
    const refRs = await pool
      .request()
      .input('rid', sql.Int, subId)
      .query(`
        SELECT Id, OrdemExibicao
        FROM dbo.CadastroCargo
        WHERE Id = @rid AND Ativo = 1;
      `);
    if (!refRs.recordset?.length) {
      return res.status(400).json({
        error: 'Cargo de referência não encontrado no catálogo.',
        field: 'subordinadoACargoId',
      });
    }
    const refRow = refRs.recordset[0];
    const ordRef = rsGet(refRow, 'OrdemExibicao');
    if (ordRef == null || ordRef === '') {
      return res.status(400).json({
        error:
          'Esse cargo não tem ordem de exibição definida. Escolha outro (por exemplo, um cargo padrão do sistema).',
        field: 'subordinadoACargoId',
      });
    }
    const R = Math.floor(Number(ordRef));
    if (!Number.isFinite(R)) {
      return res.status(400).json({
        error: 'A ordem do cargo de referência é inválida.',
        field: 'subordinadoACargoId',
      });
    }
    const novaOrdem = R + 1;
    try {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      let row;
      try {
        await new sql.Request(tx)
          .input('R', sql.Int, R)
          .query(`
            UPDATE dbo.CadastroCargo
            SET OrdemExibicao = OrdemExibicao + 1
            WHERE Ativo = 1 AND OrdemExibicao > @R;
          `);
        const ins = await new sql.Request(tx)
          .input('nome', sql.NVarChar(120), nomeRaw)
          .input('desc', sql.NVarChar(500), descRaw.length > 0 ? descRaw : null)
          .input('setor', sql.NVarChar(80), setorRaw)
          .input('nivel', sql.NVarChar(20), nivelRaw.length > 0 ? nivelRaw : null)
          .input('novaOrdem', sql.Int, novaOrdem)
          .query(`
            INSERT INTO dbo.CadastroCargo (Nome, Descricao, Ativo, PadraoSistema, OrdemExibicao, Setor, Nivel)
            OUTPUT INSERTED.Id, INSERTED.Nome, INSERTED.Descricao, INSERTED.PadraoSistema, INSERTED.Setor, INSERTED.Nivel, INSERTED.OrdemExibicao
            VALUES (@nome, @desc, 1, 0, @novaOrdem, @setor, @nivel);
          `);
        row = ins.recordset?.[0];
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      return res.status(201).json({
        ok: true,
        cargo: {
          id: Number(rsGet(row, 'Id')),
          nome: rsStr(row, 'Nome'),
          descricao: rsStr(row, 'Descricao'),
          padraoSistema: false,
          setor: rsStr(row, 'Setor'),
          nivel: rsStr(row, 'Nivel'),
          ordemExibicao: rsGet(row, 'OrdemExibicao'),
        },
      });
    } catch (e) {
      const n = Number(e?.number ?? e?.originalError?.info?.number);
      const msg = String(e?.message || e || '');
      if (n === 2601 || n === 2627 || /UQ_CadastroCargo|duplicate key|UNIQUE KEY constraint/i.test(msg)) {
        return res.status(409).json({
          error: 'Já existe um cargo com este nome no catálogo.',
          field: 'nome',
        });
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /api/funcionarios/:id/cadastro-cargos:', err?.message || err);
    return res.status(500).json({ error: 'Não foi possível cadastrar o cargo.' });
  }
});

app.put('/api/funcionarios/:id/perfil', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    const adminPassword = String(req.body?.adminPassword || '').trim();
    if (adminPassword !== '123') {
      return res.status(403).json({ error: 'Senha de autorização inválida.' });
    }
    const setorInput = String(req.body?.setor || '').trim().slice(0, 80);
    const cargo = String(req.body?.cargo || '').trim().slice(0, 80);
    const nivel = String(req.body?.nivel || '').trim().slice(0, 20);
    const setor = normalizeSetorValue(setorInput).slice(0, 80);
    if (!setor || !cargo || !nivel) {
      return res.status(400).json({ error: 'Informe setor, cargo e nível.' });
    }

    await ensureDbCompat();
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const reqTx = new sql.Request(tx);
      const exists = await reqTx
        .input('id', sql.Int, clienteId)
        .query(`SELECT Id FROM dbo.Clientes WHERE Id = @id`);
      if (!exists.recordset?.length) {
        await tx.rollback();
        return res.status(404).json({ error: 'Cliente não encontrado.' });
      }

      await new sql.Request(tx)
        .input('id', sql.Int, clienteId)
        .query(`UPDATE dbo.Clientes SET Funcionario = 1, AtualizadoEm = SYSDATETIME() WHERE Id = @id`);

      const duplicateExact = await new sql.Request(tx)
        .input('id', sql.Int, clienteId)
        .input('setor', sql.NVarChar(80), setor)
        .input('cargo', sql.NVarChar(80), cargo)
        .input('nivel', sql.NVarChar(20), nivel)
        .query(`
          SELECT TOP 1 FuncionarioId
          FROM dbo.Funcionarios
          WHERE Ativos = 1
            AND FuncionarioId <> @id
            AND LTRIM(RTRIM(Setor)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@setor))
            AND LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@cargo))
            AND LTRIM(RTRIM(Nivel)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@nivel));
        `);
      if (duplicateExact.recordset?.length) {
        await tx.rollback();
        return res.status(409).json({
          error:
            'Já existe funcionário ativo com o mesmo setor, cargo e nível. Para cargos repetidos, altere o nível.',
        });
      }

      if (isHighLevelCargo(cargo)) {
        const duplicateHighRole = await new sql.Request(tx)
          .input('id', sql.Int, clienteId)
          .input('setor', sql.NVarChar(80), setor)
          .input('cargo', sql.NVarChar(80), cargo)
          .query(`
            SELECT TOP 1 FuncionarioId
            FROM dbo.Funcionarios
            WHERE Ativos = 1
              AND FuncionarioId <> @id
              AND LTRIM(RTRIM(Setor)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@setor))
              AND LTRIM(RTRIM(Cargo)) COLLATE Latin1_General_CI_AI = LTRIM(RTRIM(@cargo));
          `);
        if (duplicateHighRole.recordset?.length) {
          await tx.rollback();
          return res.status(409).json({
            error:
              'Cargo alto já existente neste setor (ex.: gerente/coordenador/líder). Use outro cargo.',
          });
        }
      }

      await new sql.Request(tx)
        .input('id', sql.Int, clienteId)
        .input('setor', sql.NVarChar(80), setor)
        .input('cargo', sql.NVarChar(80), cargo)
        .input('nivel', sql.NVarChar(20), nivel)
        .query(`
          MERGE dbo.Funcionarios AS target
          USING (SELECT @id AS FuncionarioId) AS src
          ON target.FuncionarioId = src.FuncionarioId
          WHEN MATCHED THEN
            UPDATE SET
              Ativos = 1,
              Setor = @setor,
              Cargo = @cargo,
              Nivel = @nivel,
              DataDesligamento = NULL
          WHEN NOT MATCHED THEN
            INSERT (FuncionarioId, Ativos, Setor, Cargo, Nivel, DataInicio, DataDesligamento)
            VALUES (@id, 1, @setor, @cargo, @nivel, SYSDATETIME(), NULL);
        `);
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    return res.json({
      ok: true,
      perfil: {
        funcionario: true,
        ativo: true,
        setor,
        cargo,
        nivel,
        podeVerEscalaTrabalho: podeAcessarEscalaTrabalho(cargo),
      },
    });
  } catch (err) {
    console.error('PUT /api/funcionarios/:id/perfil:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao salvar perfil de funcionário.',
      detail: String(err?.message || err),
    });
  }
});

/**
 * 1 = em serviço (Sim), 0 = fora (Não). Atualiza horários em dbo.PontoEletronicoDia (calendário deriva presença).
 * Horários gravados no horário civil de Brasília (America/Sao_Paulo), não em UTC.
 * Sequência esperada: 1º Sim → EntradaEm; 1º Não → SaidaAlmocoEm; 2º Sim → VoltaAlmocoEm; 2º Não → SaidaExpedienteEm.
 * Toques extra além da 4ª marca: nenhum campo muda (o MERGE repete os mesmos valores).
 * 1º toque Não sem EntradaEm: não abre nova batida (só StatusTrabalho / PresencaDia, se existir).
 * Cria linha do dia no MERGE se ainda não existir. JornadaTrechosJson espelha esses quatro horários.
 */
app.put('/api/funcionarios/:id/status-trabalho', async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    const rawSt = req.body?.statusTrabalho;
    let st = Number(rawSt);
    if (rawSt === true || rawSt === 'true' || rawSt === 'sim' || rawSt === 'Sim') st = 1;
    if (rawSt === false || rawSt === 'false' || rawSt === 'nao' || rawSt === 'não' || rawSt === 'Não')
      st = 0;
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    if (st === 2) st = 0;
    if (st !== 1 && st !== 0) {
      return res.status(400).json({ error: 'statusTrabalho deve ser 1 (sim) ou 0 (não).' });
    }

    await ensureDbCompatOrFallbackAuth();
    const pool = await getPool();
    await ensurePontoEletronicoDiaSchema(pool);

    /* Dia do ponto = data civil em Brasília (servidor pode estar em UTC). */
    const diaPontoStr = hojeIsoSaoPaulo();

    /* 1ª transação: só dbo.Funcionarios.StatusTrabalho — commit imediato para não perder por falha no ponto. */
    const txStatus = new sql.Transaction(pool);
    await txStatus.begin();
    try {
      const rCli = await new sql.Request(txStatus)
        .input('id', sql.Int, clienteId)
        .query(`
          SELECT CAST(ISNULL(Funcionario, 0) AS INT) AS EhFuncionario
          FROM dbo.Clientes WHERE Id = @id;
        `);
      if (!rCli.recordset?.length) {
        await txStatus.rollback();
        return res.status(404).json({ error: 'Cliente não encontrado.' });
      }
      if (Number(rsGet(rCli.recordset[0], 'EhFuncionario') || 0) !== 1) {
        await txStatus.rollback();
        return res.status(403).json({
          error: 'Apenas cadastros marcados como funcionário podem alterar o status de trabalho.',
        });
      }

      await new sql.Request(txStatus)
        .input('id', sql.Int, clienteId)
        .input('st', sql.TinyInt, st)
        .query(`
          MERGE dbo.Funcionarios AS t
          USING (SELECT @id AS FuncionarioId, @st AS StatusTrabalho) AS s
          ON t.FuncionarioId = s.FuncionarioId
          WHEN MATCHED THEN
            UPDATE SET StatusTrabalho = s.StatusTrabalho
          WHEN NOT MATCHED THEN
            INSERT (FuncionarioId, Ativos, DataInicio, StatusTrabalho)
            VALUES (s.FuncionarioId, 1, SYSDATETIME(), s.StatusTrabalho);
        `);
      await txStatus.commit();
    } catch (eSta) {
      await txStatus.rollback();
      throw eSta;
    }

    /* 2ª transação: ponto / jornada — falha aqui não desfaz StatusTrabalho. */
    let pontoSyncErro = null;
    const txPonto = new sql.Transaction(pool);
    await txPonto.begin();
    try {
      const agoraStr = agoraSqlStringSaoPaulo();

      const rHor = await new sql.Request(txPonto)
        .input('id', sql.Int, clienteId)
        .input('diaStr', sql.NVarChar(12), diaPontoStr)
        .query(`
          SELECT EntradaEm, SaidaAlmocoEm, VoltaAlmocoEm, SaidaExpedienteEm, JornadaTrechosJson
          FROM dbo.PontoEletronicoDia
          WHERE FuncionarioId = @id AND Dia = CAST(@diaStr AS DATE);
        `);
      const rowH = rHor.recordset?.length ? rHor.recordset[0] : null;
      let ent = readPontoDiaDateTime(rowH, 'EntradaEm');
      let sa = readPontoDiaDateTime(rowH, 'SaidaAlmocoEm');
      let vol = readPontoDiaDateTime(rowH, 'VoltaAlmocoEm');
      let sex = readPontoDiaDateTime(rowH, 'SaidaExpedienteEm');

      if (ent == null && sa == null && vol == null && sex == null && rowH != null) {
        const p0 = parseJornadaTrechosJson(rsGet(rowH, 'JornadaTrechosJson'));
        if (p0.length >= 1) {
          ent = toSqlDateTime2OrNull(p0[0].e ? new Date(p0[0].e) : null);
          sa = toSqlDateTime2OrNull(p0[0].s ? new Date(p0[0].s) : null);
        }
        if (p0.length >= 2) {
          vol = toSqlDateTime2OrNull(p0[1].e ? new Date(p0[1].e) : null);
          sex = toSqlDateTime2OrNull(p0[1].s ? new Date(p0[1].s) : null);
        }
      }

      if (st === 1) {
        if (ent == null) {
          ent = agoraStr;
        } else if (sa != null && vol == null) {
          vol = agoraStr;
        }
      } else {
        if (ent != null && sa == null) {
          sa = agoraStr;
        } else if (vol != null && sex == null) {
          sex = agoraStr;
        }
      }

      const jsonOut = trechosJsonFromHorarios(ent, sa, vol, sex);
      const temPresCol = await pontoEletronicoDiaTemColunaPresencaDia(pool);
      const setPresSql = temPresCol ? ', [PresencaDia] = @pres' : '';
      const insPresColSql = temPresCol ? ', [PresencaDia]' : '';
      const insPresValSql = temPresCol ? ', @pres' : '';

      const entSql = pontoHorarioParaSqlStringBrasil(ent);
      const saSql = pontoHorarioParaSqlStringBrasil(sa);
      const volSql = pontoHorarioParaSqlStringBrasil(vol);
      const sexSql = pontoHorarioParaSqlStringBrasil(sex);

      const rqPonto = new sql.Request(txPonto)
        .input('id', sql.Int, clienteId)
        .input('diaStr', sql.NVarChar(12), diaPontoStr)
        .input('ent', sql.NVarChar(40), entSql)
        .input('sa', sql.NVarChar(40), saSql)
        .input('vol', sql.NVarChar(40), volSql)
        .input('sex', sql.NVarChar(40), sexSql)
        .input('json', sql.NVarChar(sql.MAX), jsonOut);
      if (temPresCol) rqPonto.input('pres', sql.TinyInt, st);

      /* UPDATE + INSERT: MERGE com msnodesqlv8/ODBC às vezes não grava; rowsAffected do driver também pode mentir — usa @@ROWCOUNT. */
      const upPonto = await rqPonto.query(`
          UPDATE dbo.PontoEletronicoDia
          SET
            EntradaEm = CAST(@ent AS DATETIME2(0)),
            SaidaAlmocoEm = CAST(@sa AS DATETIME2(0)),
            VoltaAlmocoEm = CAST(@vol AS DATETIME2(0)),
            SaidaExpedienteEm = CAST(@sex AS DATETIME2(0)),
            JornadaTrechosJson = @json${setPresSql}
          WHERE FuncionarioId = @id AND Dia = CAST(@diaStr AS DATE);
          SELECT CAST(@@ROWCOUNT AS INT) AS RowCt;
        `);
      const rowCtRaw = upPonto.recordset?.length ? rsGet(upPonto.recordset[0], 'RowCt') : 0;
      const rowCt = Number(rowCtRaw);
      if (!Number.isFinite(rowCt) || rowCt < 1) {
        const rqIns = new sql.Request(txPonto)
          .input('id', sql.Int, clienteId)
          .input('diaStr', sql.NVarChar(12), diaPontoStr)
          .input('ent', sql.NVarChar(40), entSql)
          .input('sa', sql.NVarChar(40), saSql)
          .input('vol', sql.NVarChar(40), volSql)
          .input('sex', sql.NVarChar(40), sexSql)
          .input('json', sql.NVarChar(sql.MAX), jsonOut);
        if (temPresCol) rqIns.input('pres', sql.TinyInt, st);
        await rqIns.query(`
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
            SaidaExpedienteEm,
            JornadaTrechosJson${insPresColSql}
          )
          VALUES (
            @id,
            CAST(@diaStr AS DATE),
            NULL,
            NULL,
            NULL,
            NULL,
            CAST(@ent AS DATETIME2(0)),
            CAST(@sa AS DATETIME2(0)),
            CAST(@vol AS DATETIME2(0)),
            CAST(@sex AS DATETIME2(0)),
            @json${insPresValSql}
          );
        `);
      }

      await txPonto.commit();
    } catch (ePonto) {
      await txPonto.rollback();
      pontoSyncErro = String(ePonto?.message || ePonto);
      console.error(
        'PUT /api/funcionarios/:id/status-trabalho — StatusTrabalho gravado; ponto:',
        pontoSyncErro
      );
    }

    return res.json({
      ok: true,
      statusTrabalho: st,
      ...(pontoSyncErro
        ? {
            pontoSyncOk: false,
            pontoSyncDetail: pontoSyncErro,
          }
        : { pontoSyncOk: true }),
    });
  } catch (err) {
    console.error('PUT /api/funcionarios/:id/status-trabalho:', err?.message || err);
    const info = err?.originalError?.info;
    const sqlDetail =
      info && typeof info.message === 'string' ? info.message : String(err?.message || err);
    return res.status(500).json({
      error: 'Falha ao atualizar status de trabalho.',
      detail: sqlDetail,
    });
  }
});

/**
 * Equipe do mesmo setor visível ao gestor (cargo hierárquico acima).
 * Query: mes=YYYY-MM & offset=0 & limit=15 (máx. 500) & status=todos|sim|nao & q= (opcional: ID ou prefixo de nome/apelido/sobrenome)
 */
app.get('/api/funcionarios/:id/equipe-escala', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }

    const mesRaw = String(req.query?.mes || '').trim();
    const mp = /^(\d{4})-(\d{1,2})$/.exec(mesRaw);
    if (!mp) {
      return res.status(400).json({ error: 'Informe mes no formato YYYY-MM.' });
    }
    const year = Number(mp[1]);
    const month = Number(mp[2]);
    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Mês inválido.' });
    }

    await ensureDbCompat();
    const pool = await getPool();
    const temColPresencaDiaCal = await pontoEletronicoDiaTemColunaPresencaDia(pool);
    const fragCal = sqlFragmentPresencaSituacaoCalendario(temColPresencaDiaCal);

    const viewerRs = await pool
      .request()
      .input('id', sql.Int, viewerId)
      .query(`
        SELECT
          c.Id AS ClienteId,
          c.Nome,
          c.Sobrenome,
          c.Apelido,
          c.Funcionario AS ClienteFuncionario,
          f.Setor,
          f.Cargo,
          CAST(ISNULL(f.Ativos, 1) AS INT) AS Ativos,
          CAST(ISNULL(f.StatusTrabalho, 0) AS TINYINT) AS StatusTrabalho,
          f.DataDesligamento
        FROM dbo.Clientes c
        LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
        WHERE c.Id = @id
          AND c.Ativo = 1;
      `);

    if (!viewerRs.recordset?.length) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    const vRow = viewerRs.recordset[0];
    const clienteEhFuncionario = sqlBitIsOne(rsGet(vRow, 'ClienteFuncionario'));
    if (!clienteEhFuncionario) {
      return res.status(403).json({ error: 'Apenas cadastros de funcionário podem consultar a escala da equipe.' });
    }

    const viewerCargo = rsStr(vRow, 'Cargo');
    const viewerSetor = rsStr(vRow, 'Setor');
    const viewerAtivo = sqlFuncionarioEstaAtivo(rsGet(vRow, 'Ativos'));

    if (!viewerCargo.trim() || !viewerSetor.trim()) {
      return res.status(400).json({
        error:
          'Complete o cadastro de funcionário (setor e cargo) nas configurações antes de abrir a escala.',
      });
    }

    if (!viewerAtivo || !podeAcessarEscalaTrabalho(viewerCargo)) {
      return res.status(403).json({ error: 'Sem permissão para consultar escala da equipe.' });
    }

    const ini = new Date(year, month - 1, 1);
    const fim = new Date(year, month, 1);

    const eqRs = await pool
      .request()
      .input('viewerId', sql.Int, viewerId)
      .input('setor', sql.NVarChar(80), viewerSetor.trim())
      .input('viewY', sql.Int, year)
      .input('viewM', sql.Int, month)
      .query(`
        SELECT
          c.Id AS ClienteId,
          c.Nome,
          c.Sobrenome,
          c.Apelido,
          f.Cargo,
          f.Setor,
          CAST(ISNULL(f.StatusTrabalho, 0) AS TINYINT) AS StatusTrabalho,
          f.DataDesligamento
        FROM dbo.Funcionarios f
        INNER JOIN dbo.Clientes c ON c.Id = f.FuncionarioId
        WHERE c.Ativo = 1
          AND f.FuncionarioId <> @viewerId
          AND LTRIM(RTRIM(ISNULL(f.Setor, N''))) COLLATE Latin1_General_CI_AI =
              LTRIM(RTRIM(@setor)) COLLATE Latin1_General_CI_AI
          AND (
            ISNULL(f.Ativos, 1) = 1
            OR (
              ISNULL(f.Ativos, 1) = 0
              AND f.DataDesligamento IS NOT NULL
              AND (YEAR(f.DataDesligamento) * 100 + MONTH(f.DataDesligamento)) >= (@viewY * 100 + @viewM)
            )
          );
      `);

    const rawRows = eqRs.recordset || [];
    const viewerRank = cargoHierarchyRank(viewerCargo);
    const equipeFull =
      viewerRank < 15
        ? []
        : rawRows
            .filter((row) =>
              colaboradorEhSubordinadoDoCargo(viewerCargo, rsStr(row, 'Cargo'))
            )
            .map((row) => ({
              id: Number(rsGet(row, 'ClienteId')),
              nome: rsStr(row, 'Nome'),
              sobrenome: rsStr(row, 'Sobrenome'),
              apelido: rsStr(row, 'Apelido'),
              cargo: rsStr(row, 'Cargo'),
              setor: rsStr(row, 'Setor'),
              statusTrabalho: normalizeStatusTrabalhoDb(rsGet(row, 'StatusTrabalho')),
              dataDesligamento: pontoDateTimeToIso(rsGet(row, 'DataDesligamento')),
            }))
            .filter((e) => Number.isInteger(e.id) && e.id > 0);

    const qRaw = String(req.query?.q ?? req.query?.busca ?? '').trim();
    let equipeComBusca = equipeFull;
    if (qRaw.length > 0) {
      if (/^\d+$/.test(qRaw)) {
        equipeComBusca = equipeFull.filter((e) => String(e.id).startsWith(qRaw));
      } else {
        const qNorm = normalizeTextKey(qRaw);
        const tokens = qNorm.split(/\s+/).filter(Boolean);
        equipeComBusca = equipeFull.filter((e) => {
          const hay = normalizeTextKey(
            [e.nome, e.sobrenome, e.apelido].filter(Boolean).join(' ')
          );
          if (tokens.length === 0) return true;
          return tokens.every((t) => hay.includes(t));
        });
      }
    }

    const rawStatus = req.query?.status;
    const statusQ = String(Array.isArray(rawStatus) ? rawStatus[0] : rawStatus ?? 'todos')
      .trim()
      .toLowerCase();
    let equipeFiltered = equipeComBusca;
    if (statusQ === 'sim' || statusQ === 'em-servico' || statusQ === 'servico')
      equipeFiltered = equipeComBusca.filter((e) => e.statusTrabalho === 1);
    else if (statusQ === 'nao' || statusQ === 'fora')
      equipeFiltered = equipeComBusca.filter((e) => e.statusTrabalho === 0);

    const selfSt = normalizeStatusTrabalhoDb(rsGet(vRow, 'StatusTrabalho'));
    const selfEntry = {
      id: viewerId,
      nome: rsStr(vRow, 'Nome'),
      sobrenome: rsStr(vRow, 'Sobrenome'),
      apelido: rsStr(vRow, 'Apelido'),
      cargo: viewerCargo,
      setor: viewerSetor.trim(),
      statusTrabalho: selfSt,
      dataDesligamento: pontoDateTimeToIso(rsGet(vRow, 'DataDesligamento')),
    };
    const selfMatchesSearch = (() => {
      if (qRaw.length === 0) return true;
      if (/^\d+$/.test(qRaw)) return String(selfEntry.id).startsWith(qRaw);
      const qNorm = normalizeTextKey(qRaw);
      const tokens = qNorm.split(/\s+/).filter(Boolean);
      const hay = normalizeTextKey(
        [selfEntry.nome, selfEntry.sobrenome, selfEntry.apelido].filter(Boolean).join(' ')
      );
      if (tokens.length === 0) return true;
      return tokens.every((t) => hay.includes(t));
    })();
    const selfMatchesStatus =
      statusQ === 'sim' || statusQ === 'em-servico' || statusQ === 'servico'
        ? selfEntry.statusTrabalho === 1
        : statusQ === 'nao' || statusQ === 'fora'
          ? selfEntry.statusTrabalho === 0
          : true;
    /* Maior cargo (rank) primeiro; desempate agrupado (coordenadores, assistente/auxiliar); cargo / nome / id. */
    equipeFiltered.sort((a, b) => {
      const ra = cargoHierarchyRank(a.cargo);
      const rb = cargoHierarchyRank(b.cargo);
      if (rb !== ra) return rb - ra;
      const sa = cargoSecundarioSortKey(a.cargo);
      const sb = cargoSecundarioSortKey(b.cargo);
      if (sb !== sa) return sb - sa;
      const cmpCargo = String(a.cargo || '').localeCompare(String(b.cargo || ''), 'pt', {
        sensitivity: 'base',
      });
      if (cmpCargo !== 0) return cmpCargo;
      const cmpNome = String(a.nome || '').localeCompare(String(b.nome || ''), 'pt', {
        sensitivity: 'base',
      });
      if (cmpNome !== 0) return cmpNome;
      const cmpSob = String(a.sobrenome || '').localeCompare(String(b.sobrenome || ''), 'pt', {
        sensitivity: 'base',
      });
      if (cmpSob !== 0) return cmpSob;
      return a.id - b.id;
    });

    let listOrdered = equipeFiltered;
    if (selfMatchesSearch && selfMatchesStatus) {
      listOrdered = [selfEntry, ...equipeFiltered];
    }

    const total = listOrdered.length;
    const offset = Math.max(0, Math.floor(Number(req.query?.offset) || 0));
    let limit = Math.floor(Number(req.query?.limit));
    if (!Number.isFinite(limit) || limit < 1) limit = 15;
    limit = Math.min(500, limit);
    const equipe = listOrdered.slice(offset, offset + limit);

    const ids = equipe.map((e) => e.id).filter((id) => Number.isInteger(id) && id > 0);
    const presencaPorId = {};
    if (ids.length > 0) {
      try {
        const presReq = pool.request();
        presReq.input('ini', sql.Date, ini);
        presReq.input('fim', sql.Date, fim);
        const parts = [];
        ids.forEach((fid, ix) => {
          const key = `id${ix}`;
          presReq.input(key, sql.Int, fid);
          parts.push(`@${key}`);
        });
        const presSql = `
          SELECT FuncionarioId, Dia, (${fragCal.situacao}) AS Situacao
          FROM dbo.PontoEletronicoDia
          WHERE Dia >= @ini AND Dia < @fim
            AND FuncionarioId IN (${parts.join(', ')})
            AND (${fragCal.situacao}) IS NOT NULL;
        `;
        const presRs = await presReq.query(presSql);
        for (const pr of presRs.recordset || []) {
          const fid = Number(rsGet(pr, 'FuncionarioId'));
          const diaVal = rsGet(pr, 'Dia');
          const diaStr =
            diaVal instanceof Date && !Number.isNaN(diaVal.getTime())
              ? diaVal.toISOString().slice(0, 10)
              : String(diaVal || '').slice(0, 10);
          const situacao = normalizePresencaSituacaoDb(rsGet(pr, 'Situacao'));
          if (situacao === undefined) continue;
          if (!presencaPorId[fid]) presencaPorId[fid] = {};
          presencaPorId[fid][diaStr] = situacao;
        }

        const detReq = pool.request();
        detReq.input('ini', sql.Date, ini);
        detReq.input('fim', sql.Date, fim);
        ids.forEach((fid, ix) => {
          detReq.input(`id${ix}`, sql.Int, fid);
        });
        const detSql = `
          SELECT FuncionarioId, Dia, Falta, Atestado, Folga, Justificativa,
            EntradaEm, AtestadoImagem
          FROM dbo.PontoEletronicoDia
          WHERE Dia >= @ini AND Dia < @fim
            AND FuncionarioId IN (${parts.join(', ')});
        `;
        const detRs = await detReq.query(detSql);
        const detPorFid = {};
        for (const dr of detRs.recordset || []) {
          const fid = Number(rsGet(dr, 'FuncionarioId'));
          const diaVal = rsGet(dr, 'Dia');
          const diaStr =
            diaVal instanceof Date && !Number.isNaN(diaVal.getTime())
              ? diaVal.toISOString().slice(0, 10)
              : String(diaVal || '').slice(0, 10);
          const img = rsStr(dr, 'AtestadoImagem');
          if (!detPorFid[fid]) detPorFid[fid] = {};
          detPorFid[fid][diaStr] = {
            falta: rsGet(dr, 'Falta') === 'S' ? 'S' : null,
            atestado: rsGet(dr, 'Atestado') === 'S' ? 'S' : null,
            folga: rsGet(dr, 'Folga') === 'S' ? 'S' : null,
            justificativa: rsStr(dr, 'Justificativa'),
            entradaEm: pontoDateTimeToIso(rsGet(dr, 'EntradaEm')),
            atestadoImagem: img.length > 0 ? img : null,
          };
        }

        const hojeEq = hojeIsoSaoPaulo();
        for (const fid of ids) {
          if (!presencaPorId[fid]) presencaPorId[fid] = {};
          try {
            aplicarRegrasPresencaAutomaticaMes(
              year,
              month,
              hojeEq,
              presencaPorId[fid],
              detPorFid[fid] || {}
            );
          } catch (regrasErr) {
            console.warn('equipe-escala aplicarRegrasPresencaAutomaticaMes:', regrasErr?.message || regrasErr);
          }
        }
      } catch (presErr) {
        console.error('GET equipe-escala (presença PontoEletronicoDia):', presErr?.message || presErr);
        /* Devolve equipe sem mapa de dias — melhor que falhar a lista inteira. */
      }
    }

    const equipeOut = equipe.map((e) => ({
      ...e,
      presencaDias: presencaPorId[e.id] || {},
    }));

    return res.json({
      ok: true,
      mes: mesRaw,
      viewer: {
        cargo: viewerCargo,
        setor: viewerSetor.trim(),
      },
      equipe: equipeOut,
      total,
      offset,
      limit,
      hasMore: offset + equipe.length < total,
      status: statusQ === 'sim' || statusQ === 'nao' ? statusQ : 'todos',
      q: qRaw,
    });
  } catch (err) {
    console.error('GET /api/funcionarios/:id/equipe-escala:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao carregar equipe.',
      detail: String(err?.message || err),
    });
  }
});

/**
 * Registra desligamento no vínculo (DataDesligamento + Ativos = 0 para sair da equipe e bloquear uso como ativo).
 * DataDesligamento em horário civil de Brasília (igual ponto / status-trabalho), não UTC.
 * Mesmo critério de visão que equipe + subordinado; só coordenador+ / gerente (rank ≥ 40, ver podeGerirCatalogoDeCargos).
 */
app.put('/api/funcionarios/:id/desligar-colaborador', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    const colaboradorId = Number(req.body?.colaboradorId);
    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) {
      return res.status(400).json({ error: 'colaboradorId inválido.' });
    }

    await ensureDbCompat();
    const pool = await getPool();

    const val = await validarGestorPodeVerColaboradorEquipe(pool, viewerId, colaboradorId);
    if (!val.ok) {
      return res.status(val.status).json({ error: val.error });
    }
    if (!podeGerirCatalogoDeCargos(val.viewerCargo)) {
      return res.status(403).json({
        error:
          'Apenas coordenadores e cargos equivalentes ou superiores podem registrar desligamento pela equipe.',
      });
    }

    const desligamentoBr = agoraSqlStringSaoPaulo();
    const up = await pool
      .request()
      .input('colabId', sql.Int, colaboradorId)
      .input('desl', sql.NVarChar(40), desligamentoBr)
      .query(`
      UPDATE dbo.Funcionarios
      SET DataDesligamento = CAST(@desl AS DATETIME2(0)),
          Ativos = 0
      WHERE FuncionarioId = @colabId
        AND ISNULL(Ativos, 1) = 1;
    `);
    let ok = rowsAffectedFirst(up) >= 1;
    /* ODBC: recordset/rowsAffected às vezes não refletem o UPDATE; confirma no banco. */
    if (!ok) {
      const chk = await pool
        .request()
        .input('colabId', sql.Int, colaboradorId)
        .query(`
          SELECT CAST(ISNULL(Ativos, 1) AS INT) AS Ativos
          FROM dbo.Funcionarios
          WHERE FuncionarioId = @colabId;
        `);
      if (!chk.recordset?.length) {
        return res.status(404).json({ error: 'Colaborador não encontrado na tabela de funcionários.' });
      }
      const atv = Number(rsGet(chk.recordset[0], 'Ativos') || 1);
      if (atv === 0) ok = true;
      else {
        return res.status(404).json({
          error: 'Não foi possível atualizar o registro (colaborador já desligado ou dados divergentes).',
        });
      }
    }

    return res.json({ ok: true, colaboradorId });
  } catch (err) {
    console.error('PUT /api/funcionarios/:id/desligar-colaborador:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao registrar desligamento.',
      detail: String(err?.message || err),
    });
  }
});

/**
 * Presença (calendário) de um subordinado no mês — mesmo setor e hierarquia que equipe-escala.
 * Query: colaboradorId=ClienteId & mes=YYYY-MM
 * Rota alternativa (sem path com :id): GET /api/presenca-colaborador-mes?viewerId=&colaboradorId=&mes=
 * — evita 404 em proxies que não repassam segmentos dinâmicos corretamente.
 */
async function sendPresencaColaboradorMes(res, viewerId, colaboradorId, mesRaw) {
  if (!Number.isInteger(viewerId) || viewerId <= 0) {
    return res.status(400).json({ error: 'Cliente inválido.' });
  }
  if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) {
    return res.status(400).json({ error: 'colaboradorId inválido.' });
  }

  const mp = /^(\d{4})-(\d{1,2})$/.exec(mesRaw);
  if (!mp) {
    return res.status(400).json({ error: 'Informe mes no formato YYYY-MM.' });
  }
  const year = Number(mp[1]);
  const month = Number(mp[2]);
  if (month < 1 || month > 12) {
    return res.status(400).json({ error: 'Mês inválido.' });
  }

  await ensureDbCompat();
  const pool = await getPool();
  const temColPresencaDiaCal = await pontoEletronicoDiaTemColunaPresencaDia(pool);
  const fragCal = sqlFragmentPresencaSituacaoCalendario(temColPresencaDiaCal);

  const ehProprio = colaboradorId === viewerId;

  if (ehProprio) {
    const vr = await pool
      .request()
      .input('id', sql.Int, viewerId)
      .query(`
        SELECT
          c.Funcionario AS ClienteFuncionario,
          f.Setor,
          f.Cargo,
          f.Ativos
        FROM dbo.Clientes c
        LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
        WHERE c.Id = @id AND c.Ativo = 1;
      `);
    if (!vr.recordset?.length) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const row = vr.recordset[0];
    if (Number(rsGet(row, 'ClienteFuncionario') || 0) !== 1) {
      return res.status(403).json({ error: 'Apenas cadastros de funcionário podem ver a própria escala.' });
    }
    const cg = rsStr(row, 'Cargo');
    const viewerAtivo = Number(rsGet(row, 'Ativos') || 0) === 1;
    if (!cg.trim() || !rsStr(row, 'Setor').trim()) {
      return res.status(400).json({
        error: 'Complete setor e cargo nas configurações antes de abrir o calendário.',
      });
    }
    if (!viewerAtivo || !podeAcessarEscalaTrabalho(cg)) {
      return res.status(403).json({ error: 'Sem permissão para consultar a escala.' });
    }
  } else {
    const val = await validarGestorPodeVerColaboradorEquipe(pool, viewerId, colaboradorId);
    if (!val.ok) {
      return res.status(val.status).json({ error: val.error });
    }
  }

  const ini = new Date(year, month - 1, 1);
  const fim = new Date(year, month, 1);

  const presReq = pool.request();
  presReq.input('ini', sql.Date, ini);
  presReq.input('fim', sql.Date, fim);
  presReq.input('fid', sql.Int, colaboradorId);
  const presRs = await presReq.query(`
    SELECT Dia, (${fragCal.situacao}) AS Situacao
    FROM dbo.PontoEletronicoDia
    WHERE Dia >= @ini AND Dia < @fim
      AND FuncionarioId = @fid
      AND (${fragCal.situacao}) IS NOT NULL;
  `);

  const presencaDias = {};
  for (const pr of presRs.recordset || []) {
    const diaVal = rsGet(pr, 'Dia');
    const diaStr =
      diaVal instanceof Date
        ? diaVal.toISOString().slice(0, 10)
        : String(diaVal || '').slice(0, 10);
    const sitNorm = normalizePresencaSituacaoDb(rsGet(pr, 'Situacao'));
    if (sitNorm !== undefined) {
      presencaDias[diaStr] = sitNorm;
    }
  }

  const diaDetalhes = {};
  try {
    const detRs = await pool
      .request()
      .input('ini', sql.Date, ini)
      .input('fim', sql.Date, fim)
      .input('fid', sql.Int, colaboradorId)
      .query(`
        SELECT Dia, Falta, Atestado, Folga, Justificativa,
          EntradaEm, SaidaAlmocoEm, VoltaAlmocoEm, SaidaExpedienteEm,
          AtestadoImagem
        FROM dbo.PontoEletronicoDia
        WHERE FuncionarioId = @fid AND Dia >= @ini AND Dia < @fim;
      `);
    for (const dr of detRs.recordset || []) {
      const diaVal = rsGet(dr, 'Dia');
      const diaStr =
        diaVal instanceof Date
          ? diaVal.toISOString().slice(0, 10)
          : String(diaVal || '').slice(0, 10);
      const img = rsStr(dr, 'AtestadoImagem');
      diaDetalhes[diaStr] = {
        falta: rsGet(dr, 'Falta') === 'S' ? 'S' : null,
        atestado: rsGet(dr, 'Atestado') === 'S' ? 'S' : null,
        folga: rsGet(dr, 'Folga') === 'S' ? 'S' : null,
        justificativa: rsStr(dr, 'Justificativa'),
        entradaEm: pontoDateTimeToIso(rsGet(dr, 'EntradaEm')),
        saidaAlmocoEm: pontoDateTimeToIso(rsGet(dr, 'SaidaAlmocoEm')),
        voltaAlmocoEm: pontoDateTimeToIso(rsGet(dr, 'VoltaAlmocoEm')),
        saidaExpedienteEm: pontoDateTimeToIso(rsGet(dr, 'SaidaExpedienteEm')),
        atestadoImagem: img.length > 0 ? img : null,
      };
    }
  } catch (detErr) {
    console.warn('PontoEletronicoDia (presença):', detErr?.message || detErr);
  }

  try {
    aplicarRegrasPresencaAutomaticaMes(year, month, hojeIsoSaoPaulo(), presencaDias, diaDetalhes);
  } catch (regrasErr) {
    console.warn('aplicarRegrasPresencaAutomaticaMes:', regrasErr?.message || regrasErr);
  }

  return res.json({
    ok: true,
    mes: mesRaw,
    colaboradorId,
    presencaDias,
    diaDetalhes,
  });
}

app.get('/api/funcionarios/:id/presenca-colaborador-mes', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    const colaboradorId = Number(req.query?.colaboradorId);
    const mesRaw = String(req.query?.mes || '').trim();
    return await sendPresencaColaboradorMes(res, viewerId, colaboradorId, mesRaw);
  } catch (err) {
    console.error('GET /api/funcionarios/:id/presenca-colaborador-mes:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao carregar presença.',
      detail: String(err?.message || err),
    });
  }
});

app.get('/api/presenca-colaborador-mes', async (req, res) => {
  try {
    const viewerId = Number(req.query?.viewerId);
    const colaboradorId = Number(req.query?.colaboradorId);
    const mesRaw = String(req.query?.mes || '').trim();
    return await sendPresencaColaboradorMes(res, viewerId, colaboradorId, mesRaw);
  } catch (err) {
    console.error('GET /api/presenca-colaborador-mes:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao carregar presença.',
      detail: String(err?.message || err),
    });
  }
});

/**
 * Presença rápida no calendário (coluna PresencaDia): 1 = trabalhou, 0 = falta, null = limpar (cinza).
 * Mesma regra de permissão que ponto-dia-detalhe (próprio ou gestor da equipe).
 * Body: { colaboradorId, dia: YYYY-MM-DD, presenca: 0 | 1 | null }
 */
async function handlePresencaDiaRapidaPut(req, res, viewerId) {
  try {
    const colaboradorId = Number(req.body?.colaboradorId);
    const diaRaw = String(req.body?.dia || '').trim();
    const rawPres = req.body?.presenca;

    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) {
      return res.status(400).json({ error: 'colaboradorId inválido.' });
    }
    const dp = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(diaRaw);
    if (!dp) {
      return res.status(400).json({ error: 'Informe dia no formato YYYY-MM-DD.' });
    }
    const y = Number(dp[1]);
    const mo = Number(dp[2]);
    const d = Number(dp[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) {
      return res.status(400).json({ error: 'Data inválida.' });
    }
    const diaDate = new Date(y, mo - 1, d);

    let presVal = null;
    if (rawPres === null || rawPres === undefined || rawPres === 'clear') {
      presVal = null;
    } else if (rawPres === 0 || rawPres === '0') {
      presVal = 0;
    } else if (rawPres === 1 || rawPres === '1') {
      presVal = 1;
    } else {
      return res.status(400).json({ error: 'presenca deve ser 0, 1 ou null.' });
    }

    await ensureDbCompat();
    const pool = await getPool();
    await ensurePontoEletronicoDiaSchema(pool);

    const temPresCol = await pontoEletronicoDiaTemColunaPresencaDia(pool);
    if (!temPresCol) {
      return res.status(503).json({
        error:
          'Coluna PresencaDia indisponível neste banco. Execute as migrações do servidor ou atualize o schema.',
      });
    }

    const viewerRs = await pool
      .request()
      .input('id', sql.Int, viewerId)
      .query(`
        SELECT c.Funcionario AS ClienteFuncionario, f.Cargo, f.Ativos
        FROM dbo.Clientes c
        LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
        WHERE c.Id = @id AND c.Ativo = 1;
      `);
    if (!viewerRs.recordset?.length) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const viewerRow = viewerRs.recordset[0];
    const ehProprio = colaboradorId === viewerId;
    if (ehProprio) {
      if (Number(rsGet(viewerRow, 'ClienteFuncionario') || 0) !== 1) {
        return res.status(403).json({ error: 'Apenas funcionários podem alterar este registro.' });
      }
      if (Number(rsGet(viewerRow, 'Ativos') || 0) !== 1) {
        return res.status(403).json({ error: 'Cadastro de funcionário inativo.' });
      }
      if (!podeAcessarEscalaTrabalho(rsStr(viewerRow, 'Cargo'))) {
        return res.status(403).json({ error: 'Sem permissão para alterar este registro.' });
      }
    } else {
      const val = await validarGestorPodeVerColaboradorEquipe(pool, viewerId, colaboradorId);
      if (!val.ok) {
        return res.status(val.status).json({ error: val.error });
      }
    }

    if (presVal === null) {
      await pool
        .request()
        .input('fid', sql.Int, colaboradorId)
        .input('dia', sql.Date, diaDate)
        .query(`
          UPDATE dbo.PontoEletronicoDia
          SET [PresencaDia] = NULL,
              Falta = NULL
          WHERE FuncionarioId = @fid AND Dia = @dia;
        `);
      await pool
        .request()
        .input('fid', sql.Int, colaboradorId)
        .input('dia', sql.Date, diaDate)
        .query(`
          DELETE FROM dbo.PontoEletronicoDia
          WHERE FuncionarioId = @fid AND Dia = @dia
            AND Falta IS NULL AND Atestado IS NULL AND Folga IS NULL
            AND (Justificativa IS NULL OR LTRIM(RTRIM(Justificativa)) = N'')
            AND EntradaEm IS NULL AND SaidaAlmocoEm IS NULL AND VoltaAlmocoEm IS NULL AND SaidaExpedienteEm IS NULL
            AND (AtestadoImagem IS NULL OR LTRIM(RTRIM(CAST(AtestadoImagem AS NVARCHAR(4000)))) = N'')
            AND (JornadaTrechosJson IS NULL OR LTRIM(RTRIM(JornadaTrechosJson)) IN (N'', N'[]'))
            AND [PresencaDia] IS NULL;
        `);
    } else {
      const faltaIns = presVal === 0 ? 'S' : null;
      const up = await pool
        .request()
        .input('fid', sql.Int, colaboradorId)
        .input('dia', sql.Date, diaDate)
        .input('pres', sql.TinyInt, presVal)
        .query(`
          UPDATE dbo.PontoEletronicoDia
          SET
            [PresencaDia] = @pres,
            Falta = CASE WHEN @pres = 0 THEN N'S' ELSE NULL END,
            Folga = CASE WHEN @pres = 0 AND Folga = N'S' THEN NULL ELSE Folga END
          WHERE FuncionarioId = @fid AND Dia = @dia;
          SELECT CAST(@@ROWCOUNT AS INT) AS RowCt;
        `);
      const rowCtRaw = up.recordset?.length ? rsGet(up.recordset[0], 'RowCt') : 0;
      const rowCt = Number(rowCtRaw);
      if (!Number.isFinite(rowCt) || rowCt < 1) {
        await pool
          .request()
          .input('fid', sql.Int, colaboradorId)
          .input('dia', sql.Date, diaDate)
          .input('pres', sql.TinyInt, presVal)
          .input('faltaIns', sql.NVarChar(1), faltaIns)
          .query(`
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
              SaidaExpedienteEm,
              [PresencaDia]
            )
            VALUES (
              @fid,
              @dia,
              @faltaIns,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              @pres
            );
          `);
      }
    }

    return res.json({ ok: true, dia: diaRaw, colaboradorId, presenca: presVal });
  } catch (err) {
    console.error('PUT presenca-dia-rapida:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao salvar presença rápida.',
      detail: String(err?.message || err),
    });
  }
}

app.put('/api/funcionarios/:id/presenca-dia-rapida', async (req, res) => {
  const viewerId = Number(req.params.id);
  return handlePresencaDiaRapidaPut(req, res, viewerId);
});

/**
 * Rota alternativa (sem path com :id): PUT /api/presenca-dia-rapida?viewerId=
 * — mesma razão que GET /api/presenca-colaborador-mes (proxies que não repassam segmentos dinâmicos).
 */
app.put('/api/presenca-dia-rapida', async (req, res) => {
  const viewerId = Number(req.query?.viewerId);
  return handlePresencaDiaRapidaPut(req, res, viewerId);
});

/**
 * Falta / Atestado / Folga / Justificativa por dia (PontoEletronicoDia).
 * Próprio dia: qualquer cargo pode falta, atestado, justificativa (ex.: falta + justificativa).
 * Folga no próprio dia só para Gerente, Coordenador, gestor ou rank ≥ 40.
 * Outro colaborador: se passar em validarGestorPodeVerColaboradorEquipe (mesmo critério da lista),
 * pode editar tudo: falta, atestado, folga e justificativa (supervisor, líder, encarregado, coordenador, etc.).
 * Body: { colaboradorId, dia, falta?, atestado?, folga?, justificativa?, atestadoImagem? }
 */
app.put('/api/funcionarios/:id/ponto-dia-detalhe', async (req, res) => {
  try {
    const viewerId = Number(req.params.id);
    const colaboradorId = Number(req.body?.colaboradorId);
    const diaRaw = String(req.body?.dia || '').trim();
    if (!Number.isInteger(viewerId) || viewerId <= 0) {
      return res.status(400).json({ error: 'Cliente inválido.' });
    }
    if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) {
      return res.status(400).json({ error: 'colaboradorId inválido.' });
    }
    const dp = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(diaRaw);
    if (!dp) {
      return res.status(400).json({ error: 'Informe dia no formato YYYY-MM-DD.' });
    }
    const y = Number(dp[1]);
    const mo = Number(dp[2]);
    const d = Number(dp[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) {
      return res.status(400).json({ error: 'Data inválida.' });
    }
    const diaDate = new Date(y, mo - 1, d);

    const body = req.body || {};
    const faltaB = body.falta;
    const atestB = body.atestado;
    const folgaB = body.folga;
    let faltaCol = faltaB === true || faltaB === 'S' || faltaB === 1 ? 'S' : null;
    const atestCol = atestB === true || atestB === 'S' || atestB === 1 ? 'S' : null;
    let folgaCol = folgaB === true || folgaB === 'S' || folgaB === 1 ? 'S' : null;
    /* Falta e Folga são excludentes (se ambos vierem "S", prioriza Falta e zera Folga). */
    if (faltaCol === 'S' && folgaCol === 'S') {
      folgaCol = null;
    }
    const just = String(body.justificativa ?? '').trim();
    const justificativaCol = just.length > 0 ? just.slice(0, 2000) : null;

    await ensureDbCompat();
    const pool = await getPool();
    await ensurePontoEletronicoDiaSchema(pool);

    const viewerRs = await pool
      .request()
      .input('id', sql.Int, viewerId)
      .query(`
        SELECT c.Funcionario AS ClienteFuncionario, f.Cargo, f.Ativos
        FROM dbo.Clientes c
        LEFT JOIN dbo.Funcionarios f ON f.FuncionarioId = c.Id
        WHERE c.Id = @id AND c.Ativo = 1;
      `);
    if (!viewerRs.recordset?.length) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    const viewerRow = viewerRs.recordset[0];
    const viewerCargo = rsStr(viewerRow, 'Cargo');
    const ehProprio = colaboradorId === viewerId;
    const podeAltoGestorProprio = cargoPodeFolgaEJustificativaAltoGestorNoProprio(viewerCargo);

    if (ehProprio) {
      if (Number(rsGet(viewerRow, 'ClienteFuncionario') || 0) !== 1) {
        return res.status(403).json({ error: 'Apenas funcionários podem alterar este registro.' });
      }
      if (Number(rsGet(viewerRow, 'Ativos') || 0) !== 1) {
        return res.status(403).json({ error: 'Cadastro de funcionário inativo.' });
      }
      if (!podeAcessarEscalaTrabalho(viewerCargo)) {
        return res.status(403).json({ error: 'Sem permissão para alterar este registro.' });
      }
      if (!podeAltoGestorProprio) {
        const tentouFolgaProprio =
          folgaCol === 'S' || folgaB === true || folgaB === 'S' || folgaB === 1;
        if (tentouFolgaProprio) {
          return res.status(403).json({
            error:
              'Você não pode registrar folga no próprio dia. Use falta e justificativa se necessário, ou peça a um gerente ou coordenador. Folgas de subordinados são lançadas no calendário de cada um.',
          });
        }
        folgaCol = null;
      }
    } else {
      const val = await validarGestorPodeVerColaboradorEquipe(pool, viewerId, colaboradorId);
      if (!val.ok) {
        return res.status(val.status).json({ error: val.error });
      }
    }

    const hasImagemKeyG = Object.prototype.hasOwnProperty.call(body, 'atestadoImagem');
    let setImagemSqlG = '';
    const rqG = pool
      .request()
      .input('fid', sql.Int, colaboradorId)
      .input('dia', sql.Date, diaDate)
      .input('falta', sql.NVarChar(1), faltaCol)
      .input('atest', sql.NVarChar(1), atestCol)
      .input('folga', sql.NVarChar(1), folgaCol)
      .input('just', sql.NVarChar(sql.MAX), justificativaCol);
    if (hasImagemKeyG) {
      const raw = body.atestadoImagem;
      if (raw === null || raw === '') {
        setImagemSqlG = ', AtestadoImagem = NULL';
      } else if (typeof raw === 'string') {
        rqG.input('atestImg', sql.NVarChar(sql.MAX), raw);
        setImagemSqlG = ', AtestadoImagem = @atestImg';
      } else {
        return res.status(400).json({ error: 'atestadoImagem inválido.' });
      }
    }

    const imagemPreenchida =
      hasImagemKeyG &&
      body.atestadoImagem !== null &&
      body.atestadoImagem !== '' &&
      typeof body.atestadoImagem === 'string';
    const limparTudoSemImagemNova =
      faltaCol == null &&
      atestCol == null &&
      folgaCol == null &&
      justificativaCol == null &&
      !imagemPreenchida;

    if (limparTudoSemImagemNova) {
      await rqG.query(`
        UPDATE dbo.PontoEletronicoDia
        SET Falta = NULL,
            Atestado = NULL,
            Folga = NULL,
            Justificativa = NULL,
            AtestadoImagem = NULL
        WHERE FuncionarioId = @fid AND Dia = @dia;
      `);
      return res.json({
        ok: true,
        dia: diaRaw,
        colaboradorId,
        falta: null,
        atestado: null,
        folga: null,
        justificativa: '',
        atestadoImagem: null,
      });
    }

    const insertImgG = imagemPreenchida ? '@atestImg' : 'NULL';

    /* MERGE com ODBC/msnodesqlv8 falha ou não persiste em alguns ambientes — UPDATE + INSERT + @@ROWCOUNT. */
    const upRes = await rqG.query(`
      UPDATE dbo.PontoEletronicoDia
      SET
        Falta = @falta,
        Atestado = @atest,
        Folga = @folga,
        Justificativa = @just
        ${setImagemSqlG}
      WHERE FuncionarioId = @fid AND Dia = @dia;
      SELECT CAST(@@ROWCOUNT AS INT) AS RowCt;
    `);
    const rowCtRaw = upRes.recordset?.length ? rsGet(upRes.recordset[0], 'RowCt') : 0;
    const rowCt = Number(rowCtRaw);
    if (!Number.isFinite(rowCt) || rowCt < 1) {
      const rqIns = pool
        .request()
        .input('fid', sql.Int, colaboradorId)
        .input('dia', sql.Date, diaDate)
        .input('falta', sql.NVarChar(1), faltaCol)
        .input('atest', sql.NVarChar(1), atestCol)
        .input('folga', sql.NVarChar(1), folgaCol)
        .input('just', sql.NVarChar(sql.MAX), justificativaCol);
      if (insertImgG === '@atestImg') {
        rqIns.input('atestImg', sql.NVarChar(sql.MAX), body.atestadoImagem);
      }
      await rqIns.query(`
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
          SaidaExpedienteEm,
          AtestadoImagem
        )
        VALUES (@fid, @dia, @falta, @atest, @folga, @just, NULL, NULL, NULL, NULL, ${insertImgG});
      `);
    }

    const imgSel = await pool
      .request()
      .input('fid', sql.Int, colaboradorId)
      .input('dia', sql.Date, diaDate)
      .query(
        `SELECT AtestadoImagem FROM dbo.PontoEletronicoDia WHERE FuncionarioId = @fid AND Dia = @dia;`
      );
    const imgOut = imgSel.recordset?.length ? rsStr(imgSel.recordset[0], 'AtestadoImagem') : '';

    return res.json({
      ok: true,
      dia: diaRaw,
      colaboradorId,
      falta: faltaCol,
      atestado: atestCol,
      folga: folgaCol,
      justificativa: justificativaCol || '',
      atestadoImagem: imgOut.length > 0 ? imgOut : null,
    });
  } catch (err) {
    console.error('PUT /api/funcionarios/:id/ponto-dia-detalhe:', err?.message || err);
    return res.status(500).json({
      error: 'Falha ao salvar detalhes do dia.',
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

