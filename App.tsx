import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { BlurView } from 'expo-blur';
import * as ImageManipulator from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import type { AuthSessionResult } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  type AppStateStatus,
  Dimensions,
  useWindowDimensions,
  Easing,
  Image,
  ImageBackground,
  ImageSourcePropType,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  GestureHandlerRootView,
  Swipeable,
  FlatList as GHFlatList,
  TouchableOpacity as GHTouchableOpacity,
} from 'react-native-gesture-handler';

WebBrowser.maybeCompleteAuthSession();

function readApiUrlFromAppConfig(): string | undefined {
  const pick = (extra: { apiUrl?: unknown } | undefined | null): string | undefined => {
    const v = extra?.apiUrl;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) return t;
    }
    return undefined;
  };
  const fromExpo = pick(Constants.expoConfig?.extra as { apiUrl?: string } | undefined);
  if (fromExpo) return fromExpo;
  const legacyManifest = Constants.manifest as { extra?: { apiUrl?: string } } | null | undefined;
  const fromManifest = pick(legacyManifest?.extra);
  if (fromManifest) return fromManifest;
  const m2 = Constants.manifest2 as
    | { extra?: { expoClient?: { extra?: { apiUrl?: string } } } }
    | null
    | undefined;
  const fromM2 = pick(m2?.extra?.expoClient?.extra);
  if (fromM2) return fromM2;
  return undefined;
}

/** No emulador Android, 192.168.x.x do PC não alcança o host; precisa de 10.0.2.2. */
function androidLikelyEmulator(): boolean {
  if (Platform.OS !== 'android') return false;
  const c = Platform.constants as {
    Fingerprint?: string;
    Model?: string;
    Brand?: string;
    Manufacturer?: string;
  };
  const fp = (c.Fingerprint || '').toLowerCase();
  const model = (c.Model || '').toLowerCase();
  const brand = (c.Brand || '').toLowerCase();
  const manu = (c.Manufacturer || '').toLowerCase();
  return (
    model.includes('emulator') ||
    model.startsWith('sdk_gphone') ||
    fp.includes('generic') ||
    fp.includes('emulator') ||
    /google_sdk/.test(fp) ||
    brand === 'generic' ||
    manu.includes('genymotion')
  );
}

function apiBaseUrl(): string {
  if (__DEV__ && Platform.OS === 'android' && androidLikelyEmulator()) {
    return 'http://10.0.2.2:3000';
  }
  const fromExtra = readApiUrlFromAppConfig();
  if (fromExtra) {
    return fromExtra.replace(/\/$/, '');
  }
  if (__DEV__ && Platform.OS === 'android') {
    return 'http://10.0.2.2:3000';
  }
  return __DEV__ ? 'http://localhost:3000' : 'http://localhost:3000';
}

/** Sem isso o fetch pode ficar minutos esperando se o servidor não responder (ex.: backend parado). */
const API_FETCH_TIMEOUT_MS = 15000;
const PHOTO_UPLOAD_TIMEOUT_MS = 120000;
/** Visitantes: encerra sessão após inactividade. Funcionários (cadastro com Funcionario=1) não sofrem este limite. */
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PROFILE_PHOTO_TARGET_SIZE = 600;
const PROFILE_PHOTO_TARGET_QUALITY = 0.72;
const MAX_PROFILE_PHOTO_BYTES = 25 * 1024 * 1024;
const ATESTADO_IMAGE_MAX_WIDTH = 1400;
const ATESTADO_IMAGE_QUALITY = 0.78;
function storageKeyFuncionarioEmServico(clienteId: number): string {
  return `choco_funcionario_em_servico_${clienteId}`;
}

/** Chave legada (timestamp); removida ao carregar o perfil para não conflitar com StatusTrabalho no servidor. */
function storageKeyFuncionarioEmServicoTs(clienteId: number): string {
  return `choco_funcionario_em_servico_ts_${clienteId}`;
}

/** Alinhado à hierarquia do backend (server.js). */
function normalizeCargoKeyApp(cargo: string): string {
  return String(cargo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Gerente → coordenador → supervisor → … → analista → assistente → auxiliar (igual ao server.js). */
function cargoHierarchyRankApp(cargo: string): number {
  const k = normalizeCargoKeyApp(cargo);
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
 * Desempate dentro do mesmo rank: maior = mais acima na lista (agrupamento por tipo de cargo).
 * Coordenadores: ordem fixa (Geral → Admin. → …); no mesmo patamar, nome resolve.
 * Base (rank 5): Analista > Assistente > Auxiliar.
 */
function cargoSecundarioSortKeyApp(cargo: string): number {
  const k = normalizeCargoKeyApp(cargo);
  if (!k) return 0;
  if (k.includes('coordenador')) {
    if (k.includes('coordenador geral')) return 10_000;
    if (k.includes('administrativ')) return 9_990;
    if (k.includes('senior') || k.includes('sênior')) return 9_980;
    if (/\bti\b/.test(k) || k.includes('de ti') || k.includes('coordenador ti')) return 9_970;
    if (k.includes('seguranca') || k.includes('segurança')) return 9_960;
    if (k.includes('operacoes') || k.includes('operações')) return 9_950;
    if (k.includes('manutencao') || k.includes('manutenção')) return 9_940;
    if (k.includes('atendimento')) return 9_930;
    if (k.includes('alimentos')) return 9_920;
    return 5_000;
  }
  if (k.includes('analista')) return 250;
  if (k.includes('assistente')) return 200;
  if (k.includes('auxiliar')) return 100;
  return 0;
}

/** Alinhado ao backend: base (5) até gestão (50); lista da escala só subordinados se rank ≥ 15. */
function podeAcessarEscalaTrabalhoApp(cargo: string): boolean {
  const r = cargoHierarchyRankApp(cargo);
  return r >= 5 && r <= 50;
}

function formatAnoMes(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

const ESCALA_PAGE_SIZE = 15;
const ESCALA_POLL_MS = 8000;

/** Primeiro nome para linha da escala: prefere primeiro token do apelido, senão do nome. */
function primeiroNomeEscala(nome: string, apelido: string): string {
  const a = (apelido || '').trim();
  if (a) return a.split(/\s+/)[0] || a;
  const n = (nome || '').trim();
  if (!n) return '—';
  return n.split(/\s+/)[0] || n;
}

type EscalaMembro = {
  id: number;
  nome: string;
  sobrenome: string;
  apelido: string;
  cargo: string;
  setor: string;
  statusTrabalho: number;
  presencaDias: Record<string, number>;
  /** ISO; quando o desligamento cai no mês visualizado, a UI risca o nome e destaca a linha. */
  dataDesligamento?: string | null;
};

/** API pode enviar 0/1, bit ou string — só 1 conta como em serviço (Sim). */
function parseStatusTrabalhoEquipeApi(raw: unknown): number {
  if (raw === true || raw === 1) return 1;
  if (typeof raw === 'string' && raw.trim() === '1') return 1;
  const n = Number(raw);
  return n === 1 ? 1 : 0;
}

function mapEquipeApiRow(row: Record<string, unknown>): EscalaMembro {
  const ds = row.dataDesligamento;
  return {
    id: Number(row.id),
    nome: typeof row.nome === 'string' ? row.nome : '',
    sobrenome: typeof row.sobrenome === 'string' ? row.sobrenome : '',
    apelido: typeof row.apelido === 'string' ? row.apelido : '',
    cargo: typeof row.cargo === 'string' ? row.cargo : '',
    setor: typeof row.setor === 'string' ? row.setor : '',
    statusTrabalho: parseStatusTrabalhoEquipeApi(row.statusTrabalho),
    presencaDias:
      row.presencaDias && typeof row.presencaDias === 'object' && row.presencaDias !== null
        ? (row.presencaDias as Record<string, number>)
        : {},
    dataDesligamento: typeof ds === 'string' && ds.length > 0 ? ds : null,
  };
}

/** YYYY-MM a partir de data ISO (entrada/servidor). */
function anoMesDeDataIso(iso: string | null | undefined): string | null {
  if (!iso || typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(iso.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function membroDesligadoNoMesVisualizado(dataDesligamento: string | null | undefined, mesYm: string): boolean {
  const ym = anoMesDeDataIso(dataDesligamento ?? null);
  return ym != null && ym === mesYm;
}

function presencaDiasIgual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = Object.prototype.hasOwnProperty.call(a, k) ? a[k] : undefined;
    const bv = Object.prototype.hasOwnProperty.call(b, k) ? b[k] : undefined;
    if (av !== bv) return false;
  }
  return true;
}

/** Maior cargo (rank) primeiro; depois agrupamento fino (coordenadores, assistente/auxiliar) — igual ao backend. */
function sortEscalaEquipePorCargo(items: EscalaMembro[]): EscalaMembro[] {
  return [...items].sort((a, b) => {
    const ra = cargoHierarchyRankApp(a.cargo);
    const rb = cargoHierarchyRankApp(b.cargo);
    if (rb !== ra) return rb - ra;
    const sa = cargoSecundarioSortKeyApp(a.cargo);
    const sb = cargoSecundarioSortKeyApp(b.cargo);
    if (sb !== sa) return sb - sa;
    const ca = String(a.cargo || '').localeCompare(String(b.cargo || ''), 'pt-BR', {
      sensitivity: 'base',
    });
    if (ca !== 0) return ca;
    const na = primeiroNomeEscala(a.nome, a.apelido).toLocaleLowerCase('pt-BR');
    const nb = primeiroNomeEscala(b.nome, b.apelido).toLocaleLowerCase('pt-BR');
    const cmp = na.localeCompare(nb, 'pt-BR', { sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    return a.id - b.id;
  });
}

/**
 * Pode marcar falta/folga/justificativa em colaborador subordinado (API equipe + ponto-dia-detalhe).
 * Inclui Supervisor, Líder, Encarregado, Coordenador, Gerente.
 */
function cargoPodeGerirMarcacoesPontoOutros(cargo: string): boolean {
  const k = normalizeCargoKeyApp(cargo);
  if (!k) return false;
  if (k.includes('gerente')) return true;
  if (k.includes('coordenador')) return true;
  if (k.includes('lider')) return true;
  if (k.includes('encarregad')) return true;
  if (k.includes('supervisor')) return true;
  if (k.includes('gestor')) return true;
  const r = cargoHierarchyRankApp(cargo);
  if (r >= 40) return true;
  return false;
}

/** Registrar desligamento pelo swipe na equipe: coordenador+ / rank ≥ 40 (igual catálogo de cargos no servidor). */
function cargoPodeDesligarColaboradorEscala(cargo: string): boolean {
  return cargoHierarchyRankApp(cargo) >= 40;
}

/** Folga no próprio dia: Gerente, Coordenador, gestor ou rank ≥ 40. Demais cargos: falta e justificativa OK, folga não. */
function cargoPodeFolgaNoProprioPonto(cargo: string): boolean {
  const k = normalizeCargoKeyApp(cargo);
  if (!k) return false;
  if (k.includes('gerente')) return true;
  if (k.includes('coordenador')) return true;
  if (k.includes('gestor')) return true;
  return cargoHierarchyRankApp(cargo) >= 40;
}

/** Mantém o usuário logado como primeira linha (resposta da API já vem assim; reforça após merge no cliente). */
function ordenarEscalaComSelfPrimeiro(items: EscalaMembro[], selfId: number | null): EscalaMembro[] {
  if (selfId == null) return sortEscalaEquipePorCargo(items);
  const seen = new Map<number, EscalaMembro>();
  for (const it of items) seen.set(it.id, it);
  const uniq = Array.from(seen.values());
  const self = uniq.find((i) => i.id === selfId);
  const rest = uniq.filter((i) => i.id !== selfId);
  return self ? [self, ...sortEscalaEquipePorCargo(rest)] : sortEscalaEquipePorCargo(uniq);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = API_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

type ApiJsonBody = {
  error?: string;
  detail?: string;
  hint?: string;
  ok?: boolean;
  cliente?: {
    id?: number;
    email?: string;
    telefone?: string;
    nome?: string;
    sobrenome?: string;
    apelido?: string;
    fotoPerfil?: string;
    funcionario?: boolean;
    funcionarioAtivo?: boolean;
  };
};

async function readApiJsonResponse(res: Response): Promise<{ raw: string; data: ApiJsonBody }> {
  const raw = await res.text();
  if (!raw.trim()) return { raw, data: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { raw, data: parsed as ApiJsonBody };
    }
    return { raw, data: {} };
  } catch {
    return { raw, data: {} };
  }
}

function estimateDataUriBytes(dataUri: string): number {
  const marker = ';base64,';
  const idx = dataUri.indexOf(marker);
  if (idx < 0) return 0;
  const b64 = dataUri.slice(idx + marker.length);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

const EMAIL_CLIENT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailClient(value: string): boolean {
  return EMAIL_CLIENT_REGEX.test(value.trim().toLowerCase());
}

/** Brasil: DD/MM/AAAA → AAAA-MM-DD para a API. */
function parseDataNascimentoBrToIso(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1900 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Só dígitos (máx. 8) → DD/MM/AAAA com barras à medida que se digita. */
function formatDataNascimentoDigits(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Só números (máx. 11) → 000.000.000-00 */
function formatCpfDigits(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

/** CPF brasileiro: 11 dígitos e dígitos verificadores válidos. */
function isCpfValid(digits11: string): boolean {
  if (digits11.length !== 11 || !/^\d{11}$/.test(digits11)) return false;
  if (/^(\d)\1{10}$/.test(digits11)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits11[i], 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 >= 10) d1 = 0;
  if (d1 !== parseInt(digits11[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits11[i], 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 >= 10) d2 = 0;
  return d2 === parseInt(digits11[10], 10);
}

type GoogleAuthProps = {
  response: AuthSessionResult | null | undefined;
  promptAsync: (options?: Record<string, unknown>) => Promise<AuthSessionResult>;
};

type AppInnerProps = {
  googleAuth: GoogleAuthProps | null;
};

type RegisterErrors = {
  email?: string;
  password?: string;
  nomeCompleto?: string;
  dataNascimento?: string;
  cpf?: string;
};

type MapLocal = {
  codigo: string;
  nome: string;
  tipo: string;
  categoria?: string;
  classificacao?: string;
  alturaMinCm?: number;
  aberto?: boolean | null;
  tempoFilaMin?: number | null;
  imagemUrl?: string | null;
  /** Ícone no mapa: URL absoluta ou caminho relativo ao API (ex.: /map-icons/icon-banho.png). */
  iconeMapaUrl?: string | null;
  descricao?: string;
  // Retângulo clicável em percentuais normalizados (0..1) dentro da imagem quadrada do mapa.
  x: number;
  y: number;
  w: number;
  h: number;
};

type MapHotspotCategoria = 'banheiro' | 'comida' | 'diversao';

const BUNDLED_MAP_ICONS: Record<MapHotspotCategoria, ImageSourcePropType> = {
  banheiro: require('./assets/icon-banho.png'),
  comida: require('./assets/icon-comida.png'),
  diversao: require('./assets/icon-diversao.png'),
};

function stripDiacriticsForCompare(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Chave interna para ícones / pulso / legenda — independente de maiúsculas e acentos no SQL. */
function normalizeMapCategoriaKey(
  categoria: string | undefined,
  tipo: string
): MapHotspotCategoria {
  const norm = stripDiacriticsForCompare((categoria || '').trim());
  if (norm === 'banheiro') return 'banheiro';
  if (norm === 'comida') return 'comida';
  if (norm === 'diversao') return 'diversao';
  if (tipo === 'banheiro') return 'banheiro';
  if (tipo === 'restaurante' || tipo === 'lanchonete') return 'comida';
  return 'diversao';
}

/** Rótulo em português para exibir no app. */
function mapCategoriaDisplayLabel(local: Pick<MapLocal, 'categoria' | 'tipo'>): string {
  switch (normalizeMapCategoriaKey(local.categoria, local.tipo)) {
    case 'banheiro':
      return 'Banheiro';
    case 'comida':
      return 'Comida';
    default:
      return 'Diversão';
  }
}

function mapStatusDisplayLabel(local: Pick<MapLocal, 'aberto'>): string {
  return local.aberto === true ? 'Aberto' : 'Fechado';
}

function resolveMapHotspotCategoria(local: Pick<MapLocal, 'categoria' | 'tipo'>): MapHotspotCategoria {
  return normalizeMapCategoriaKey(local.categoria, local.tipo);
}

function mapHotspotIconSource(local: MapLocal): ImageSourcePropType {
  const raw = local.iconeMapaUrl?.trim();
  if (raw) {
    if (/^https?:\/\//i.test(raw)) {
      return { uri: raw };
    }
    if (raw.startsWith('/')) {
      return { uri: `${apiBaseUrl()}${raw}` };
    }
  }
  return BUNDLED_MAP_ICONS[resolveMapHotspotCategoria(local)];
}

function locaisDaCategoria(locais: MapLocal[], cat: MapHotspotCategoria): MapLocal[] {
  return locais.filter((l) => resolveMapHotspotCategoria(l) === cat);
}

function isLocalClosed(local: Pick<MapLocal, 'aberto'>): boolean {
  return local.aberto === false;
}

/** Texto secundário da legenda: só classificação e/ou altura (fila e status ficam à direita). */
function mapLegendItemClassificacaoAlturaLine(local: MapLocal): string {
  const parts: string[] = [];
  if (local.classificacao?.trim()) {
    parts.push(local.classificacao.trim());
  }
  if (local.alturaMinCm != null && local.alturaMinCm > 0) {
    parts.push(`Altura m\u00edn. ${local.alturaMinCm} cm`);
  }
  return parts.join(' \u00b7 ');
}

/** Locais que entram na lista da legenda (todos com código válido vindos da API). */
function mapLocalExibirNaLegendaDoMapa(codigo: string): boolean {
  return String(codigo ?? '').trim().length > 0;
}

/** Imagens estáveis (HTTPS) para o card do mapa — evita Wikimedia, que costuma falhar no app. */
const MAP_CACAU_SHOW_INFO_IMAGES = [
  'https://images.unsplash.com/photo-1511381939415-c1c1c269d1fc?auto=format&fit=crop&w=1200&q=80',
  'https://images.unsplash.com/photo-1481391319762-47eadfd02a8a?auto=format&fit=crop&w=1200&q=80',
  'https://images.unsplash.com/photo-1549007994-c8b45102949e?auto=format&fit=crop&w=1200&q=80',
];

function isCacauShowMapLocal(local: Pick<MapLocal, 'codigo' | 'nome'>): boolean {
  const code = (local.codigo || '').trim().toLowerCase().replace(/\s+/g, '');
  if (code === 'cacau-show' || code === 'cacaushow') return true;
  const n = stripDiacriticsForCompare((local.nome || '').trim());
  return n.includes('cacau') && n.includes('show');
}

function mapLocalFallbackImageUrl(local: Pick<MapLocal, 'codigo' | 'tipo' | 'nome'>): string | null {
  if (isCacauShowMapLocal(local)) return MAP_CACAU_SHOW_INFO_IMAGES[0];
  const code = (local.codigo || '').trim().toLowerCase();
  switch (code) {
    case 'banheiro-topo':
      return 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80';
    case 'restaurante-direita':
      return 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80';
    case 'lanchonete-meio':
      return 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80';
    case 'montanha-russa-encantada':
      return 'https://images.unsplash.com/photo-1526481280695-3c687fd643ed?auto=format&fit=crop&w=1200&q=80';
    case 'pkaleo':
      return 'https://images.unsplash.com/photo-1520975661595-6453be3f7070?auto=format&fit=crop&w=1000&q=80';
    case 'cacau-show':
      return MAP_CACAU_SHOW_INFO_IMAGES[0];
    default:
      return local.tipo === 'banheiro'
        ? 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
        : null;
  }
}

function mapLocalImageCandidates(local: Pick<MapLocal, 'codigo' | 'tipo' | 'imagemUrl' | 'nome'>): string[] {
  const list: string[] = [];
  const pushIfValid = (value?: string | null) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.length > 0 && !list.includes(v)) list.push(v);
  };
  // Cacau Show: URLs boas primeiro (ImagemUrl do banco pode ser Wikimedia e quebrar no RN).
  if (isCacauShowMapLocal(local)) {
    for (const u of MAP_CACAU_SHOW_INFO_IMAGES) pushIfValid(u);
  }
  pushIfValid(local.imagemUrl);
  pushIfValid(mapLocalFallbackImageUrl(local));
  // Fallbacks por código para garantir que sempre exista uma alternativa.
  const codeNorm = (local.codigo || '').trim().toLowerCase();
  if (codeNorm === 'montanha-russa-encantada') {
    pushIfValid('https://images.unsplash.com/photo-1526481280695-3c687fd643ed?auto=format&fit=crop&w=1200&q=80');
    pushIfValid('https://images.unsplash.com/photo-1520975661595-6453be3f7070?auto=format&fit=crop&w=1200&q=80');
  }
  if (codeNorm === 'cacau-show' || isCacauShowMapLocal(local)) {
    pushIfValid('https://images.unsplash.com/photo-1519750157634-b6b7a7e2f1b1?auto=format&fit=crop&w=1200&q=80');
  }
  if (local.tipo === 'banheiro') {
    pushIfValid(
      'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
    );
  } else if (local.tipo === 'restaurante' || local.tipo === 'lanchonete') {
    pushIfValid(
      'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80'
    );
  } else {
    pushIfValid('https://images.unsplash.com/photo-1526481280695-3c687fd643ed?auto=format&fit=crop&w=1200&q=80');
  }
  return list;
}

const MAP_LEGEND_ROWS: { key: MapHotspotCategoria; title: string; subtitle: string }[] = [
  { key: 'banheiro', title: 'Banheiros', subtitle: 'WC e espa\u00e7os de apoio' },
  { key: 'comida', title: 'Comida e bebidas', subtitle: 'Restaurantes e lanchonetes' },
  { key: 'diversao', title: 'Divers\u00e3o', subtitle: 'Atra\u00e7\u00f5es e shows' },
];

/** Tamanho único do círculo do ícone no mapa (legenda usa o mesmo valor para manter consistência). */
const MAP_HOTSPOT_MARK_SIZE = 40;

/** Borda pulsante por categoria: cores discretas (opacidade animada em separado). */
function mapHotspotPulseRingColor(cat: MapHotspotCategoria): string {
  switch (cat) {
    case 'banheiro':
      return 'rgb(232, 108, 108)';
    case 'comida':
      return 'rgb(92, 158, 242)';
    default:
      return 'rgb(78, 178, 118)';
  }
}

/** Halo que se dissipa — mesma cor do raio, preenchimento suave (opacidade animada no componente). */
function mapHotspotShineFillColor(cat: MapHotspotCategoria): string {
  switch (cat) {
    case 'banheiro':
      return 'rgb(232, 108, 108)';
    case 'comida':
      return 'rgb(92, 158, 242)';
    default:
      return 'rgb(78, 178, 118)';
  }
}

/** Zoom do PNG dentro do círculo: categoria diversão com um pouco mais de crop para esconder borda clara. */
function mapHotspotIconInsetScale(cat: MapHotspotCategoria): number {
  return cat === 'diversao' ? 1.24 : 1.1;
}

// Hotspots quando a API está indisponível — mesmas caixas que `mapa_locais_schema.sql`
// (malha 1024×1024, origem inferior esquerda na arte; X/Y normalizados canto sup. esq. no app).
const MAP_LOCAIS_DEMO: MapLocal[] = [
  {
    codigo: 'banheiro-topo',
    nome: 'Banheiro',
    tipo: 'banheiro',
    categoria: 'Banheiro',
    descricao: 'Higiene e frald\u00e1rio.',
    aberto: false,
    imagemUrl:
      'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80',
    x: 0.863438,
    y: 0.572109,
    w: 0.07,
    h: 0.055,
  },
  {
    codigo: 'restaurante-direita',
    nome: 'Restaurante',
    tipo: 'restaurante',
    categoria: 'Comida',
    descricao: 'Pratos e sobremesas.',
    aberto: false,
    imagemUrl:
      'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80',
    x: 0.40875,
    y: 0.710859,
    w: 0.09,
    h: 0.07,
  },
  {
    codigo: 'lanchonete-meio',
    nome: 'Lanchonete',
    tipo: 'lanchonete',
    categoria: 'Comida',
    descricao: 'Lanches r\u00e1pidos e bebidas.',
    aberto: false,
    imagemUrl:
      'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80',
    x: 0.619063,
    y: 0.691563,
    w: 0.09,
    h: 0.07,
  },
  {
    codigo: 'montanha-russa-encantada',
    nome: 'Montanha Russa encantada',
    tipo: 'atracao',
    categoria: 'Divers\u00e3o',
    descricao: 'Brinquedo emocionante com percurso encantado.',
    classificacao: 'Infantil, Adulto',
    alturaMinCm: 140,
    aberto: true,
    tempoFilaMin: 30,
    imagemUrl:
      'https://upload.wikimedia.org/wikipedia/commons/3/3d/Kingda_Ka.jpg',
    x: 0.286797,
    y: 0.124922,
    w: 0.11,
    h: 0.09,
  },
  {
    codigo: 'pkaleo',
    nome: 'PKaleo',
    tipo: 'atracao',
    categoria: 'Divers\u00e3o',
    descricao: 'Brinquedo emocionante!',
    classificacao: 'Infantil',
    alturaMinCm: 110,
    aberto: true,
    tempoFilaMin: 35,
    imagemUrl:
      'https://images.unsplash.com/photo-1520975661595-6453be3f7070?auto=format&fit=crop&w=800&q=80',
    x: 0.155078,
    y: 0.420391,
    w: 0.1,
    h: 0.085,
  },
  {
    codigo: 'cacau-show',
    nome: 'Cacau Show',
    tipo: 'atracao',
    categoria: 'Divers\u00e3o',
    descricao: 'Show e experi\u00eancias.',
    classificacao: 'Adulto',
    alturaMinCm: 140,
    aberto: false,
    tempoFilaMin: null,
    imagemUrl:
      'https://images.unsplash.com/photo-1511381939415-c1c1c269d1fc?auto=format&fit=crop&w=1200&q=80',
    x: 0.765547,
    y: 0.379063,
    w: 0.12,
    h: 0.09,
  },
];

/** Locais com \u00edcone/moeda no mapa: c\u00f3digo num\u00e9rico 1\u20136, ou slugs do demo offline (legenda pode listar todos). */
const MAP_LOCAIS_CODIGO_DEMO_COM_PIN = new Set(
  'banheiro-topo restaurante-direita lanchonete-meio montanha-russa-encantada pkaleo cacau-show'.split(' ')
);

function mapLocalCodigoExibePinNoMapa(codigo: string): boolean {
  const raw = String(codigo ?? '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (MAP_LOCAIS_CODIGO_DEMO_COM_PIN.has(lower)) return true;
  if (!/^\d+$/.test(raw)) return false;
  const n = parseInt(raw, 10);
  return n >= 1 && n <= 6;
}

function AppInner({ googleAuth }: AppInnerProps) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [activeSlide, setActiveSlide] = useState(0);
  const [activeHotelSlide, setActiveHotelSlide] = useState(0);
  const [factoryImageAttempt, setFactoryImageAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<'home' | 'ingressos' | 'mapa' | 'perfil'>('home');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authLoginMethod, setAuthLoginMethod] = useState<'email' | 'google' | null>(null);
  const [isFuncionarioAtivo, setIsFuncionarioAtivo] = useState(false);
  /** Coluna Clientes.Funcionario (=1 cadastro marcado como funcionário). Controla FAB config / área de expediente. */
  const [isClienteCadastroFuncionario, setIsClienteCadastroFuncionario] = useState(false);
  /** true = login em conta já existente (e-mail/senha ou Google); cartão mostra "Feliz hoje!". */
  const [loggedInAsReturning, setLoggedInAsReturning] = useState(false);
  const [userNome, setUserNome] = useState('');
  const [currentClienteId, setCurrentClienteId] = useState<number | null>(null);
  const [profileNome, setProfileNome] = useState('');
  const [profileSobrenome, setProfileSobrenome] = useState('');
  const [profileApelido, setProfileApelido] = useState('');
  const [profileModalVisible, setProfileModalVisible] = useState(false);
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [addressModalVisible, setAddressModalVisible] = useState(false);
  const [photoPickerVisible, setPhotoPickerVisible] = useState(false);
  const [photoPreviewVisible, setPhotoPreviewVisible] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteDoneVisible, setDeleteDoneVisible] = useState(false);
  const [funcionarioConfigVisible, setFuncionarioConfigVisible] = useState(false);
  const [funcionarioAuthVisible, setFuncionarioAuthVisible] = useState(false);
  const [funcionarioAdminPass, setFuncionarioAdminPass] = useState('');
  const [funcionarioAuthPassError, setFuncionarioAuthPassError] = useState('');
  const [funcionarioProfileVisible, setFuncionarioProfileVisible] = useState(false);
  const [funcionarioSetor, setFuncionarioSetor] = useState('');
  const [funcionarioCargo, setFuncionarioCargo] = useState('');
  const [funcionarioNivel, setFuncionarioNivel] = useState('');
  const [funcionarioSaving, setFuncionarioSaving] = useState(false);
  /** true se já havia setor/cargo/nível antes de abrir o modal (PUT = alteração; senão = primeiro cadastro). */
  const funcionarioPerfilJaExistiaRef = useRef(false);
  /** true = em expediente (ex.: limpeza); usado para futuras notificações de serviços pendentes. */
  const [funcionarioEmServico, setFuncionarioEmServico] = useState<boolean | null>(null);
  const [perfilFuncionarioGestao, setPerfilFuncionarioGestao] = useState<{
    cargo: string;
    podeVerEscalaTrabalho: boolean;
    podeGerirCatalogoCargos: boolean;
    statusTrabalho: number;
    setor: string;
  } | null>(null);
  const [cadastroCargosVisible, setCadastroCargosVisible] = useState(false);
  const [cadastroCargosList, setCadastroCargosList] = useState<
    {
      id: number;
      nome: string;
      descricao: string;
      padraoSistema: boolean;
      setor: string;
      nivel: string;
      ordemExibicao: number | null;
    }[]
  >([]);
  const [cadastroCargosLoading, setCadastroCargosLoading] = useState(false);
  const [cadastroCargosError, setCadastroCargosError] = useState<string | null>(null);
  const [cadastroCargosNovoNome, setCadastroCargosNovoNome] = useState('');
  const [cadastroCargosNovoSetor, setCadastroCargosNovoSetor] = useState('');
  const [cadastroCargosNovoNivel, setCadastroCargosNovoNivel] = useState('');
  const [cadastroCargosNovoDesc, setCadastroCargosNovoDesc] = useState('');
  const [cadastroCargosSaving, setCadastroCargosSaving] = useState(false);
  const [cadastroCargosSubordinadoAId, setCadastroCargosSubordinadoAId] = useState<number | null>(
    null
  );
  const [cadastroCargosSuperiorPickerOpen, setCadastroCargosSuperiorPickerOpen] = useState(false);
  const [cadastroCargosFieldErrors, setCadastroCargosFieldErrors] = useState<{
    nome?: string;
    setor?: string;
    nivel?: string;
    descricao?: string;
    subordinadoACargoId?: string;
  }>({});
  const [perfilFuncionarioGestaoLoading, setPerfilFuncionarioGestaoLoading] = useState(false);
  const [escalaTrabalhoVisible, setEscalaTrabalhoVisible] = useState(false);
  const [escalaMesYm, setEscalaMesYm] = useState(() => formatAnoMes(new Date()));
  const [escalaFiltroTrabalhando, setEscalaFiltroTrabalhando] = useState<
    'todos' | 'sim' | 'nao'
  >('todos');
  const [escalaBuscaInput, setEscalaBuscaInput] = useState('');
  const [escalaBuscaQuery, setEscalaBuscaQuery] = useState('');
  const [escalaEquipe, setEscalaEquipe] = useState<EscalaMembro[]>([]);
  const [escalaEquipeTotal, setEscalaEquipeTotal] = useState(0);
  const [escalaEquipeHasMore, setEscalaEquipeHasMore] = useState(false);
  const [escalaEquipeLoading, setEscalaEquipeLoading] = useState(false);
  const [escalaEquipeLoadingMore, setEscalaEquipeLoadingMore] = useState(false);
  const [escalaEquipeError, setEscalaEquipeError] = useState<string | null>(null);
  const [escalaDesligandoId, setEscalaDesligandoId] = useState<number | null>(null);
  const [escalaDesligarConfirm, setEscalaDesligarConfirm] = useState<{
    colaboradorId: number;
    nomeExibicao: string;
  } | null>(null);
  /** Linha aberta no gesto de desligar — só dar .close() ao fechar o popup ou confirmar. */
  const escalaSwipeDesligarRef = useRef<InstanceType<typeof Swipeable> | null>(null);
  const fecharConfirmDesligarComSwipe = useCallback(() => {
    if (escalaDesligandoId != null) return;
    const sw = escalaSwipeDesligarRef.current;
    escalaSwipeDesligarRef.current = null;
    setEscalaDesligarConfirm(null);
    sw?.close();
  }, [escalaDesligandoId]);
  /** Atualizado a cada render — evita usar length defasado do useEffect no polling da lista. */
  const escalaEquipeRef = useRef<EscalaMembro[]>([]);
  escalaEquipeRef.current = escalaEquipe;

  /** Cargo do usuário logado: perfil; se vazio, usa a linha do próprio na lista da escala (ex.: Gerente). */
  const getCargoViewerParaGestaoPonto = useCallback((): string => {
    let c = perfilFuncionarioGestao?.cargo?.trim() ?? '';
    if (!c && currentClienteId != null) {
      const row = escalaEquipe.find((m) => m.id === currentClienteId);
      if (row?.cargo?.trim()) c = row.cargo.trim();
    }
    return c;
  }, [currentClienteId, perfilFuncionarioGestao?.cargo, escalaEquipe]);

  /**
   * Cargos de base (rank &lt; 15, igual ao backend) só têm a si na equipe — esconde Todos / Em serviço / Fora.
   * Sem cargo no perfil ainda: mostra filtros só se estiver carregando ou se o total da API for &gt; 1.
   */
  const mostrarFiltrosEscalaEquipe = useMemo(() => {
    const cargoEv = getCargoViewerParaGestaoPonto().trim();
    const rankEv = cargoEv.length > 0 ? cargoHierarchyRankApp(cargoEv) : null;
    if (rankEv == null) return escalaEquipeLoading || escalaEquipeTotal > 1;
    return rankEv >= 15;
  }, [getCargoViewerParaGestaoPonto, escalaEquipeLoading, escalaEquipeTotal]);

  useEffect(() => {
    if (!escalaTrabalhoVisible) return;
    if (!mostrarFiltrosEscalaEquipe && escalaFiltroTrabalhando !== 'todos') {
      setEscalaFiltroTrabalhando('todos');
    }
  }, [escalaTrabalhoVisible, mostrarFiltrosEscalaEquipe, escalaFiltroTrabalhando]);

  const [escalaCalendarioColaborador, setEscalaCalendarioColaborador] = useState<{
    /** Id do cliente / funcionário (mesmo # da lista). */
    clienteId: number;
    /** Nome e sobrenome como na linha da escala. */
    nomeSobrenome: string;
  } | null>(null);
  const escalaCalendarioColabIdRef = useRef<number | null>(null);
  escalaCalendarioColabIdRef.current = escalaCalendarioColaborador?.clienteId ?? null;
  /** Evita disparar o ciclo rápido depois de abrir o modal por toque longo. */
  const presencaCalLongPressRef = useRef(false);
  const [escalaCalendarioMesYm, setEscalaCalendarioMesYm] = useState(() => formatAnoMes(new Date()));
  const [escalaCalendarioPresencaDias, setEscalaCalendarioPresencaDias] = useState<
    Record<string, number>
  >({});
  const [escalaCalendarioPresencaLoading, setEscalaCalendarioPresencaLoading] = useState(false);
  const [escalaCalendarioPresencaError, setEscalaCalendarioPresencaError] = useState<string | null>(
    null
  );
  /** Dia ISO em que está gravando presença rápida (toque no calendário). */
  const [escalaPresencaRapidaSaving, setEscalaPresencaRapidaSaving] = useState<string | null>(null);
  /** Dia ISO em que está gravando folga/justificativa por swipe no calendário. */
  const [escalaDetalheSwipeSaving, setEscalaDetalheSwipeSaving] = useState<string | null>(null);
  const [escalaCalendarioDiaDetalhes, setEscalaCalendarioDiaDetalhes] = useState<
    Record<
      string,
      {
        falta: 'S' | null;
        atestado: 'S' | null;
        folga: 'S' | null;
        justificativa: string;
        atestadoImagem?: string | null;
        entradaEm?: string | null;
        saidaAlmocoEm?: string | null;
        voltaAlmocoEm?: string | null;
        saidaExpedienteEm?: string | null;
      }
    >
  >({});
  const [escalaPontoDiaModal, setEscalaPontoDiaModal] = useState<{
    diaIso: string;
    /** Aberto pelo swipe J: precisa justificar para concluir ou sair sem salvar o gesto. */
    obrigarJustificativaPosSwipeJ?: boolean;
  } | null>(null);
  const pontoDiaJustificativaInputRef = useRef<TextInput | null>(null);
  const [pontoDiaFaltaSim, setPontoDiaFaltaSim] = useState(false);
  const [pontoDiaAtestadoSim, setPontoDiaAtestadoSim] = useState(false);
  const [pontoDiaFolgaSim, setPontoDiaFolgaSim] = useState(false);
  const [pontoDiaJustificativa, setPontoDiaJustificativa] = useState('');
  /** data URI nova antes do PUT; colaborador ou gestor com permissão. */
  const [pontoDiaAtestadoImagemPending, setPontoDiaAtestadoImagemPending] = useState<string | null>(null);
  const [pontoDiaRemoverAtestadoImagem, setPontoDiaRemoverAtestadoImagem] = useState(false);
  /** URI (data ou http) da foto do atestado em visualização tela cheia. */
  const [atestadoImagemFullscreenUri, setAtestadoImagemFullscreenUri] = useState<string | null>(null);
  /** Incrementa após salvar Falta/Atestado/Folga/Justificativa — recarrega o calendário. */
  const [escalaCalPresencaRefreshSeq, setEscalaCalPresencaRefreshSeq] = useState(0);
  const [pontoDiaSaving, setPontoDiaSaving] = useState(false);
  const [pontoDiaError, setPontoDiaError] = useState<string | null>(null);
  /** Confirmação ao sair dos detalhes sem justificar (gesto J no calendário). */
  const [pontoDiaJustObrigConfirmVisible, setPontoDiaJustObrigConfirmVisible] = useState(false);

  /** Detalhes do dia: no próprio calendário, só folga fica travada quem não é alto gestor (falta e justificativa liberadas). */
  const pontoDiaPermissoesUi = useMemo(() => {
    if (escalaCalendarioColaborador == null || currentClienteId == null) {
      return { travarFalta: false, travarFolga: false, travarJust: false };
    }
    const colId = escalaCalendarioColaborador.clienteId;
    const ehProprioDia = colId === currentClienteId;
    const cargo = getCargoViewerParaGestaoPonto();
    const travarFolga = ehProprioDia && !cargoPodeFolgaNoProprioPonto(cargo);
    return {
      travarFalta: false,
      travarFolga,
      travarJust: false,
    };
  }, [
    escalaCalendarioColaborador,
    currentClienteId,
    getCargoViewerParaGestaoPonto,
    escalaPontoDiaModal,
    perfilFuncionarioGestao?.cargo,
    escalaEquipe,
  ]);

  /**
   * Calendário de presença: próprio dia sempre; outro só se gestão reconhecida ou
   * colaborador na lista da escala (mesmo critério de quem aparece em equipe-escala).
   */
  const pontoDiaGestaoColaboradorCalendario = useMemo(() => {
    if (escalaCalendarioColaborador == null || currentClienteId == null) return false;
    const colId = escalaCalendarioColaborador.clienteId;
    if (colId === currentClienteId) return true;
    const cargo = getCargoViewerParaGestaoPonto();
    if (cargoPodeGerirMarcacoesPontoOutros(cargo)) return true;
    return (
      escalaEquipe.some((m) => m.id === colId) && cargoHierarchyRankApp(cargo) >= 15
    );
  }, [
    escalaCalendarioColaborador,
    currentClienteId,
    getCargoViewerParaGestaoPonto,
    escalaEquipe,
    perfilFuncionarioGestao?.cargo,
  ]);

  /**
   * Ciclo rápido (toque) e swipe F/J: só para gestão (gerente, coordenador, supervisor, etc.)
   * ou para quem marca subordinado na equipe (rank ≥ 15). Colaborador base no próprio mês: sem atalhos;
   * continua podendo ver o calendário e abrir detalhes com toque longo.
   */
  const podeAtalhosGestaoCalendarioPresenca = useMemo(() => {
    if (escalaCalendarioColaborador == null || currentClienteId == null) return false;
    const colId = escalaCalendarioColaborador.clienteId;
    const cargo = getCargoViewerParaGestaoPonto();
    if (cargoPodeGerirMarcacoesPontoOutros(cargo)) return true;
    if (colId === currentClienteId) return false;
    return (
      escalaEquipe.some((m) => m.id === colId) && cargoHierarchyRankApp(cargo) >= 15
    );
  }, [
    escalaCalendarioColaborador,
    currentClienteId,
    getCargoViewerParaGestaoPonto,
    escalaEquipe,
    perfilFuncionarioGestao?.cargo,
  ]);

  const [profileTelefone, setProfileTelefone] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [currentPasswordVisible, setCurrentPasswordVisible] = useState(false);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [addressRua, setAddressRua] = useState('');
  const [addressBairro, setAddressBairro] = useState('');
  const [addressPais, setAddressPais] = useState('');
  const [addressCep, setAddressCep] = useState('');
  const [addressNumero, setAddressNumero] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [nomeCompleto, setNomeCompleto] = useState('');
  const [dataNascimento, setDataNascimento] = useState('');
  const [telefone, setTelefone] = useState('');
  const [cpf, setCpf] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  /** Após login de retorno: modal de boas-vindas; só depois do OK mostra o painel Perfil. */
  const [welcomeReturnModalVisible, setWelcomeReturnModalVisible] = useState(false);
  /** URI da foto do cliente (futuro); null = placeholder de chocolate. */
  const [profilePhotoUri, setProfilePhotoUri] = useState<string | null>(null);
  const [selectedMapLocal, setSelectedMapLocal] = useState<MapLocal | null>(null);
  const [mapInfoImageAttempt, setMapInfoImageAttempt] = useState(0);
  const [mapLocais, setMapLocais] = useState<MapLocal[]>([]);
  const [mapLocaisLoading, setMapLocaisLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInteractionAtRef = useRef<number>(Date.now());
  const backgroundAtRef = useRef<number | null>(null);
  /** Leitura no callback do timer (evita closure desatualizada). */
  const skipIdleLogoutFuncionarioRef = useRef(false);

  useEffect(() => {
    skipIdleLogoutFuncionarioRef.current = isClienteCadastroFuncionario;
  }, [isClienteCadastroFuncionario]);

  const signOut = (reason?: string) => {
    setIsLoggedIn(false);
    setAuthLoginMethod(null);
    setIsFuncionarioAtivo(false);
    setIsClienteCadastroFuncionario(false);
    setLoggedInAsReturning(false);
    setWelcomeReturnModalVisible(false);
    setProfilePhotoUri(null);
    setUserNome('');
    setCurrentClienteId(null);
    setProfileNome('');
    setProfileSobrenome('');
    setProfileApelido('');
    setProfileTelefone('');
    setProfileEmail('');
    setCurrentPassword('');
    setNewPassword('');
    setCurrentPasswordVisible(false);
    setNewPasswordVisible(false);
    setAddressRua('');
    setAddressBairro('');
    setAddressPais('');
    setAddressCep('');
    setAddressNumero('');
    setShowRegisterForm(false);
    setProfileModalVisible(false);
    setContactModalVisible(false);
    setPasswordModalVisible(false);
    setAddressModalVisible(false);
    setPhotoPickerVisible(false);
    setPhotoPreviewVisible(false);
    setDeleteConfirmVisible(false);
    setDeleteDoneVisible(false);
    setFuncionarioConfigVisible(false);
    setCadastroCargosVisible(false);
    setCadastroCargosList([]);
    setCadastroCargosError(null);
    setCadastroCargosNovoNome('');
    setCadastroCargosNovoSetor('');
    setCadastroCargosNovoNivel('');
    setCadastroCargosNovoDesc('');
    setCadastroCargosSubordinadoAId(null);
    setCadastroCargosSuperiorPickerOpen(false);
    setCadastroCargosFieldErrors({});
    setFuncionarioAuthVisible(false);
    setFuncionarioAdminPass('');
    setFuncionarioProfileVisible(false);
    setFuncionarioSetor('');
    setFuncionarioCargo('');
    setFuncionarioNivel('');
    setFuncionarioSaving(false);
    setFuncionarioEmServico(null);
    setPerfilFuncionarioGestao(null);
    setPerfilFuncionarioGestaoLoading(false);
    setEscalaTrabalhoVisible(false);
    setEscalaMesYm(formatAnoMes(new Date()));
    setEscalaFiltroTrabalhando('todos');
    setEscalaBuscaInput('');
    setEscalaBuscaQuery('');
    setEscalaEquipe([]);
    setEscalaEquipeTotal(0);
    setEscalaEquipeHasMore(false);
    setEscalaEquipeLoading(false);
    setEscalaEquipeLoadingMore(false);
    setEscalaEquipeError(null);
    setEscalaCalendarioColaborador(null);
    setEscalaCalendarioMesYm(formatAnoMes(new Date()));
    setEscalaCalendarioPresencaDias({});
    setEscalaCalendarioPresencaLoading(false);
    setEscalaCalendarioPresencaError(null);
    setEscalaCalendarioDiaDetalhes({});
    setEscalaCalPresencaRefreshSeq(0);
    setEscalaPontoDiaModal(null);
    setPontoDiaError(null);
    setSelectedMapLocal(null);
    if (reason) {
      Alert.alert('Sess\u00e3o', reason);
    }
    setActiveTab('home');
  };

  /** Funcionário: abre Perfil + modal de configurações; visitante: Home. */
  const aplicarTelaInicialPosLogin = (cadastroFuncionario: boolean) => {
    if (cadastroFuncionario) {
      setActiveTab('perfil');
      setFuncionarioConfigVisible(true);
    } else {
      setActiveTab('home');
      setFuncionarioConfigVisible(false);
    }
  };

  /** Sincroniza Sim/Não com dbo.Funcionarios.StatusTrabalho ao abrir sessão (resposta de auth). */
  const aplicarStatusTrabalhoDoClienteRespostaAuth = async (
    cli: { id?: unknown; funcionario?: unknown; statusTrabalho?: unknown } | null | undefined
  ) => {
    if (!cli || !cli.funcionario) return;
    if (!Object.prototype.hasOwnProperty.call(cli, 'statusTrabalho')) return;
    const cidRaw = cli.id;
    const cid = cidRaw === null || cidRaw === undefined ? NaN : Number(cidRaw);
    if (!Number.isFinite(cid)) return;
    const st = Number(cli.statusTrabalho);
    const emServico = st === 1;
    setFuncionarioEmServico(emServico);
    try {
      await AsyncStorage.setItem(storageKeyFuncionarioEmServico(cid), emServico ? '1' : '0');
      await AsyncStorage.removeItem(storageKeyFuncionarioEmServicoTs(cid));
    } catch {
      /* ignore */
    }
  };

  const loadPerfilFuncionarioGestao = useCallback(async (): Promise<string | null> => {
    if (currentClienteId == null || !isLoggedIn) return null;
    setPerfilFuncionarioGestaoLoading(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/perfil`, {});
      const data = await res.json().catch(() => ({}));
      const pf = data?.perfil;
      const marcaFuncionario =
        pf?.funcionario === true ||
        pf?.funcionario === 1 ||
        (typeof pf?.funcionario === 'string' &&
          (pf.funcionario === '1' || pf.funcionario.toLowerCase() === 'true'));
      if (res.ok && pf && (marcaFuncionario || isClienteCadastroFuncionario)) {
        const cargo = typeof pf.cargo === 'string' ? pf.cargo.trim() : '';
        const setor = typeof pf.setor === 'string' ? pf.setor.trim() : '';
        const st = Number(pf.statusTrabalho);
        const statusTrabalho = st === 1 ? 1 : 0;
        const podeApi = pf.podeVerEscalaTrabalho === true;
        const pode = podeApi || podeAcessarEscalaTrabalhoApp(cargo);
        const podeCat =
          pf.podeGerirCatalogoCargos === true || cargoHierarchyRankApp(cargo) >= 40;
        setPerfilFuncionarioGestao({
          cargo,
          setor,
          statusTrabalho,
          podeVerEscalaTrabalho: Boolean(pode),
          podeGerirCatalogoCargos: Boolean(podeCat),
        });
        /* Fonte de verdade: dbo.Funcionarios.StatusTrabalho (1 = Sim, 0 = Não). Sincroniza sempre que Cliente.Funcionario=1, mesmo sem linha ativa em Funcionarios (antes do primeiro PUT). */
        setFuncionarioEmServico(statusTrabalho === 1);
        const keyEm = storageKeyFuncionarioEmServico(currentClienteId);
        const keyTs = storageKeyFuncionarioEmServicoTs(currentClienteId);
        try {
          await AsyncStorage.setItem(keyEm, statusTrabalho === 1 ? '1' : '0');
          await AsyncStorage.removeItem(keyTs);
        } catch {
          /* ignore */
        }
        return cargo;
      }
      setPerfilFuncionarioGestao(null);
      return null;
    } catch {
      setPerfilFuncionarioGestao(null);
      return null;
    } finally {
      setPerfilFuncionarioGestaoLoading(false);
    }
  }, [currentClienteId, isLoggedIn, isClienteCadastroFuncionario]);

  useEffect(() => {
    if (funcionarioConfigVisible && isLoggedIn && currentClienteId != null) {
      void loadPerfilFuncionarioGestao();
    }
  }, [funcionarioConfigVisible, isLoggedIn, currentClienteId, loadPerfilFuncionarioGestao]);

  /** Ao logar, trocar de aba para Perfil ou voltar do background — recarrega StatusTrabalho do servidor. */
  useEffect(() => {
    if (!isLoggedIn || currentClienteId == null || !isClienteCadastroFuncionario) return;
    void loadPerfilFuncionarioGestao();
  }, [isLoggedIn, currentClienteId, isClienteCadastroFuncionario, loadPerfilFuncionarioGestao]);

  useEffect(() => {
    if (activeTab !== 'perfil') return;
    if (!isLoggedIn || currentClienteId == null || !isClienteCadastroFuncionario) return;
    void loadPerfilFuncionarioGestao();
  }, [activeTab, isLoggedIn, currentClienteId, isClienteCadastroFuncionario, loadPerfilFuncionarioGestao]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
      if (!isLoggedIn || currentClienteId == null || !isClienteCadastroFuncionario) return;
      void loadPerfilFuncionarioGestao();
    });
    return () => sub.remove();
  }, [isLoggedIn, currentClienteId, isClienteCadastroFuncionario, loadPerfilFuncionarioGestao]);

  const loadCadastroCargosCatalogo = useCallback(async () => {
    if (currentClienteId == null) return;
    setCadastroCargosLoading(true);
    setCadastroCargosError(null);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/cadastro-cargos`, {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCadastroCargosError(typeof data.error === 'string' ? data.error : `Erro ${res.status}`);
        setCadastroCargosList([]);
        return;
      }
      const raw = data.cargos;
      if (Array.isArray(raw)) {
        setCadastroCargosList(
          raw
            .map((c: Record<string, unknown>) => {
              const ox = c.ordemExibicao;
              const ordemExibicao =
                ox != null && ox !== ''
                  ? Number.isFinite(Number(ox))
                    ? Number(ox)
                    : null
                  : null;
              const id = Number(c.id);
              return {
                id,
                nome: typeof c.nome === 'string' ? c.nome : '',
                descricao: typeof c.descricao === 'string' ? c.descricao : '',
                padraoSistema:
                  c.padraoSistema === true ||
                  c.padraoSistema === 1 ||
                  c.padraoSistema === '1',
                setor: typeof c.setor === 'string' ? c.setor : '',
                nivel: typeof c.nivel === 'string' ? c.nivel : '',
                ordemExibicao,
              };
            })
            .filter((c) => Number.isInteger(c.id) && c.id > 0)
        );
      } else {
        setCadastroCargosList([]);
      }
    } catch {
      setCadastroCargosError('Não foi possível carregar o catálogo de cargos.');
      setCadastroCargosList([]);
    } finally {
      setCadastroCargosLoading(false);
    }
  }, [currentClienteId]);

  useEffect(() => {
    if (cadastroCargosVisible && currentClienteId != null) {
      setCadastroCargosFieldErrors({});
      setCadastroCargosError(null);
      setCadastroCargosSubordinadoAId(null);
      void loadCadastroCargosCatalogo();
    }
  }, [cadastroCargosVisible, currentClienteId, loadCadastroCargosCatalogo]);

  const cadastroCargosComOrdemParaSuperior = useMemo(
    () =>
      cadastroCargosList.filter(
        (c) => c.ordemExibicao != null && Number.isFinite(c.ordemExibicao)
      ),
    [cadastroCargosList]
  );

  useEffect(() => {
    if (!escalaTrabalhoVisible) return;
    const t = setTimeout(() => {
      setEscalaBuscaQuery(escalaBuscaInput.trim());
    }, 350);
    return () => clearTimeout(t);
  }, [escalaBuscaInput, escalaTrabalhoVisible]);

  const fetchEscalaPage = useCallback(
    async (offset: number, append: boolean, opts?: { silent?: boolean }) => {
      if (currentClienteId == null) return;
      const statusParam =
        escalaFiltroTrabalhando === 'sim'
          ? 'sim'
          : escalaFiltroTrabalhando === 'nao'
            ? 'nao'
            : 'todos';
      const qPart =
        escalaBuscaQuery.length > 0 ? `&q=${encodeURIComponent(escalaBuscaQuery)}` : '';
      if (!opts?.silent) {
        if (!append) setEscalaEquipeLoading(true);
        else setEscalaEquipeLoadingMore(true);
      }
      setEscalaEquipeError(null);
      try {
        const base = apiBaseUrl();
        const url = `${base}/api/funcionarios/${currentClienteId}/equipe-escala?mes=${encodeURIComponent(escalaMesYm)}&offset=${offset}&limit=${ESCALA_PAGE_SIZE}&status=${statusParam}${qPart}`;
        const res = await fetchWithTimeout(url, {});
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const det =
            typeof data.detail === 'string' && data.detail.trim()
              ? `\n\n${data.detail.trim().slice(0, 800)}`
              : '';
          const msg =
            typeof data.error === 'string' && data.error.trim()
              ? data.error.trim()
              : `Erro ${res.status}`;
          setEscalaEquipeError(`${msg}${det}`);
          if (!append) {
            setEscalaEquipe([]);
            setEscalaEquipeTotal(0);
            setEscalaEquipeHasMore(false);
          }
          return;
        }
        const list = Array.isArray(data.equipe) ? data.equipe : [];
        const mapped = list
          .map((row: Record<string, unknown>) => mapEquipeApiRow(row))
          .filter((m: EscalaMembro) => Number.isFinite(m.id) && m.id > 0);
        setEscalaEquipeTotal(Number(data.total) || 0);
        setEscalaEquipeHasMore(Boolean(data.hasMore));
        if (append)
          setEscalaEquipe((prev) =>
            ordenarEscalaComSelfPrimeiro([...prev, ...mapped], currentClienteId)
          );
        else setEscalaEquipe(ordenarEscalaComSelfPrimeiro(mapped, currentClienteId));
      } catch (e: unknown) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        const extra =
          !aborted && e instanceof Error && e.message
            ? `\n\n${e.message.slice(0, 400)}`
            : '';
        setEscalaEquipeError(
          aborted ? 'Tempo esgotado.' : `Falha ao carregar a equipe.${extra}`
        );
        if (!append) {
          setEscalaEquipe([]);
          setEscalaEquipeTotal(0);
          setEscalaEquipeHasMore(false);
        }
      } finally {
        setEscalaEquipeLoading(false);
        setEscalaEquipeLoadingMore(false);
      }
    },
    [currentClienteId, escalaMesYm, escalaFiltroTrabalhando, escalaBuscaQuery]
  );

  /** Atualiza status/presença na lista já carregada (polling), sem trocar o array inteiro — evita o FlatList voltar o scroll ao topo. */
  const refreshEscalaListaAtual = useCallback(async () => {
    if (currentClienteId == null) return;
    const lenAtual = escalaEquipeRef.current.length;
    // Com "Todos", não polla lista vazia; com Sim/Fora, polla mesmo vazio (alguém pode entrar no filtro).
    if (lenAtual === 0 && escalaFiltroTrabalhando === 'todos') return;
    const statusParam =
      escalaFiltroTrabalhando === 'sim'
        ? 'sim'
        : escalaFiltroTrabalhando === 'nao'
          ? 'nao'
          : 'todos';
    const qPart =
      escalaBuscaQuery.length > 0 ? `&q=${encodeURIComponent(escalaBuscaQuery)}` : '';
    try {
      const base = apiBaseUrl();
      const n = Math.min(500, Math.max(ESCALA_PAGE_SIZE, lenAtual));
      const url = `${base}/api/funcionarios/${currentClienteId}/equipe-escala?mes=${encodeURIComponent(escalaMesYm)}&offset=0&limit=${n}&status=${statusParam}${qPart}`;
      const res = await fetchWithTimeout(url, {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const list = Array.isArray(data.equipe) ? data.equipe : [];
      const mapped = list
        .map((row: Record<string, unknown>) => mapEquipeApiRow(row))
        .filter((m: EscalaMembro) => Number.isFinite(m.id) && m.id > 0);
      setEscalaEquipeTotal(Number(data.total) || 0);
      setEscalaEquipeHasMore(Boolean(data.hasMore));
      /* Sim/Fora: substitui pela API — merge com prev mantinha linhas que não pertencem ao filtro. */
      if (escalaFiltroTrabalhando === 'sim' || escalaFiltroTrabalhando === 'nao') {
        setEscalaEquipe(ordenarEscalaComSelfPrimeiro(mapped, currentClienteId));
        return;
      }
      setEscalaEquipe((prev) => {
        if (prev.length === 0) return prev;
        const byId = new Map<number, EscalaMembro>(mapped.map((m: EscalaMembro) => [m.id, m]));
        const prevIds = new Set(prev.map((p) => p.id));
        let changed = false;
        /* Resposta pode ser truncada (ex.: limite da API); só atualiza quem veio, não apaga o fim da lista. */
        const updated = prev.map((p) => {
          const u = byId.get(p.id);
          if (!u) return p;
          if (
            p.statusTrabalho === u.statusTrabalho &&
            presencaDiasIgual(p.presencaDias, u.presencaDias) &&
            (p.dataDesligamento ?? null) === (u.dataDesligamento ?? null)
          ) {
            return p;
          }
          changed = true;
          return {
            ...p,
            statusTrabalho: u.statusTrabalho,
            presencaDias: u.presencaDias,
            dataDesligamento: u.dataDesligamento ?? null,
          };
        });
        const novosNoTopo = mapped.filter((m: EscalaMembro) => !prevIds.has(m.id));
        if (novosNoTopo.length > 0) {
          return ordenarEscalaComSelfPrimeiro([...updated, ...novosNoTopo], currentClienteId);
        }
        if (!changed) return prev;
        const reordenado = ordenarEscalaComSelfPrimeiro(updated, currentClienteId);
        if (
          reordenado.length === prev.length &&
          reordenado.every((item, i) => item === prev[i])
        ) {
          return prev;
        }
        return reordenado;
      });
    } catch {
      /* ignore poll errors */
    }
  }, [currentClienteId, escalaMesYm, escalaFiltroTrabalhando, escalaBuscaQuery]);

  useEffect(() => {
    if (!escalaTrabalhoVisible || currentClienteId == null) return;
    setEscalaEquipe([]);
    setEscalaEquipeTotal(0);
    setEscalaEquipeHasMore(false);
    void fetchEscalaPage(0, false);
  }, [
    escalaTrabalhoVisible,
    currentClienteId,
    escalaMesYm,
    escalaFiltroTrabalhando,
    escalaBuscaQuery,
    fetchEscalaPage,
  ]);

  useEffect(() => {
    if (!escalaTrabalhoVisible || currentClienteId == null) return;
    const t = setInterval(() => {
      void refreshEscalaListaAtual();
    }, ESCALA_POLL_MS);
    return () => clearInterval(t);
  }, [escalaTrabalhoVisible, currentClienteId, refreshEscalaListaAtual]);

  const closeEscalaCalendarioColaborador = useCallback(() => {
    setEscalaCalendarioColaborador(null);
    setEscalaCalendarioPresencaDias({});
    setEscalaCalendarioPresencaError(null);
    setEscalaCalendarioPresencaLoading(false);
    setEscalaCalendarioDiaDetalhes({});
    setEscalaCalPresencaRefreshSeq(0);
    setEscalaPontoDiaModal(null);
    setPontoDiaError(null);
  }, []);

  const executarDesligarColaboradorEscala = useCallback(
    async (colabId: number) => {
      if (currentClienteId == null) return;
      setEscalaDesligandoId(colabId);
      try {
        const base = apiBaseUrl();
        const res = await fetchWithTimeout(
          `${base}/api/funcionarios/${currentClienteId}/desligar-colaborador`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ colaboradorId: colabId }),
          }
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          Alert.alert(
            'Não foi possível desligar',
            typeof data.error === 'string' ? data.error : `Erro ${res.status}`
          );
          return;
        }
        void fetchEscalaPage(0, false, { silent: true });
        if (escalaCalendarioColabIdRef.current === colabId) {
          closeEscalaCalendarioColaborador();
        }
      } catch {
        Alert.alert('Não foi possível desligar', 'Verifique a conexão e tente de novo.');
      } finally {
        setEscalaDesligandoId(null);
      }
    },
    [currentClienteId, closeEscalaCalendarioColaborador, fetchEscalaPage]
  );

  useEffect(() => {
    if (escalaCalendarioColaborador == null || currentClienteId == null) return;
    let cancelled = false;
    setEscalaCalendarioPresencaDias({});
    setEscalaCalendarioDiaDetalhes({});
    setEscalaCalendarioPresencaLoading(true);
    setEscalaCalendarioPresencaError(null);
    (async () => {
      try {
        const base = apiBaseUrl();
        const url = `${base}/api/presenca-colaborador-mes?viewerId=${currentClienteId}&colaboradorId=${escalaCalendarioColaborador.clienteId}&mes=${encodeURIComponent(escalaCalendarioMesYm)}`;
        const res = await fetchWithTimeout(url, {});
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setEscalaCalendarioPresencaError(
            typeof data.error === 'string' ? data.error : `Erro ${res.status}`
          );
          setEscalaCalendarioPresencaDias({});
          setEscalaCalendarioDiaDetalhes({});
          return;
        }
        const raw = data.presencaDias;
        const pd: Record<string, number> =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, number>)
            : {};
        setEscalaCalendarioPresencaDias(pd);
        const dd = data.diaDetalhes;
        if (dd && typeof dd === 'object' && !Array.isArray(dd)) {
          const next: Record<
            string,
            {
              falta: 'S' | null;
              atestado: 'S' | null;
              folga: 'S' | null;
              justificativa: string;
              atestadoImagem?: string | null;
              entradaEm?: string | null;
              saidaAlmocoEm?: string | null;
              voltaAlmocoEm?: string | null;
              saidaExpedienteEm?: string | null;
            }
          > = {};
          const isoTime = (x: unknown): string | null =>
            typeof x === 'string' && x.length > 0 ? x : null;
          for (const k of Object.keys(dd as Record<string, unknown>)) {
            const v = (dd as Record<string, Record<string, unknown>>)[k];
            if (!v || typeof v !== 'object') continue;
            const imgRaw = v.atestadoImagem;
            const atestadoImagem =
              typeof imgRaw === 'string' && imgRaw.trim().length > 0 ? imgRaw : null;
            next[k] = {
              falta: v.falta === 'S' ? 'S' : null,
              atestado: v.atestado === 'S' ? 'S' : null,
              folga: v.folga === 'S' ? 'S' : null,
              justificativa: typeof v.justificativa === 'string' ? v.justificativa : '',
              atestadoImagem,
              entradaEm: isoTime(v.entradaEm),
              saidaAlmocoEm: isoTime(v.saidaAlmocoEm),
              voltaAlmocoEm: isoTime(v.voltaAlmocoEm),
              saidaExpedienteEm: isoTime(v.saidaExpedienteEm),
            };
          }
          setEscalaCalendarioDiaDetalhes(next);
        } else {
          setEscalaCalendarioDiaDetalhes({});
        }
      } catch {
        if (!cancelled) {
          setEscalaCalendarioPresencaError('Falha ao carregar a presença.');
          setEscalaCalendarioPresencaDias({});
          setEscalaCalendarioDiaDetalhes({});
        }
      } finally {
        if (!cancelled) setEscalaCalendarioPresencaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [escalaCalendarioColaborador, escalaCalendarioMesYm, currentClienteId, escalaCalPresencaRefreshSeq]);

  useEffect(() => {
    if (escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ !== true) return;
    const t = setTimeout(() => pontoDiaJustificativaInputRef.current?.focus(), 380);
    return () => clearTimeout(t);
  }, [escalaPontoDiaModal?.diaIso, escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ]);

  useEffect(() => {
    if (escalaPontoDiaModal == null) setPontoDiaJustObrigConfirmVisible(false);
  }, [escalaPontoDiaModal]);

  const abrirPontoDiaModal = (
    diaIso: string,
    opts?: { obrigarJustificativaPosSwipeJ?: boolean }
  ) => {
    setPontoDiaError(null);
    const det = escalaCalendarioDiaDetalhes[diaIso];
    const presSit = escalaCalendarioPresencaDias[diaIso];
    let falta = det?.falta === 'S';
    if (presSit === 0) falta = true;
    else if (presSit === 1) falta = false;
    let folga = det?.folga === 'S';
    if (falta && folga) {
      folga = false;
    }
    setPontoDiaFaltaSim(falta);
    setPontoDiaAtestadoSim(det?.atestado === 'S');
    setPontoDiaFolgaSim(folga);
    setPontoDiaJustificativa(det?.justificativa ?? '');
    setPontoDiaAtestadoImagemPending(null);
    setPontoDiaRemoverAtestadoImagem(false);
    setEscalaPontoDiaModal({
      diaIso,
      obrigarJustificativaPosSwipeJ: Boolean(opts?.obrigarJustificativaPosSwipeJ),
    });
  };

  const tentarFecharModalDetalhesDia = () => {
    if (
      escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ &&
      pontoDiaJustificativa.trim().length === 0
    ) {
      setPontoDiaJustObrigConfirmVisible(true);
      return;
    }
    setEscalaPontoDiaModal(null);
  };

  const aplicarPresencaDiaRapido = useCallback(
    async (diaIso: string) => {
      if (currentClienteId == null || escalaCalendarioColaborador == null) return;
      if (!podeAtalhosGestaoCalendarioPresenca) return;
      const pres = escalaCalendarioPresencaDias[diaIso];
      const sit = typeof pres === 'number' ? pres : undefined;
      const next: 0 | 1 | null = sit === 1 ? 0 : sit === 0 || sit === 2 ? null : 1;

      const snapshot = { ...escalaCalendarioPresencaDias };
      setEscalaCalendarioPresencaDias((prev) => {
        const n = { ...prev };
        if (next === null) delete n[diaIso];
        else n[diaIso] = next;
        return n;
      });
      setEscalaPresencaRapidaSaving(diaIso);
      try {
        const base = apiBaseUrl();
        const res = await fetchWithTimeout(
          `${base}/api/presenca-dia-rapida?viewerId=${currentClienteId}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              colaboradorId: escalaCalendarioColaborador.clienteId,
              dia: diaIso,
              presenca: next,
            }),
          }
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : `Erro ${res.status}`);
        }
        setEscalaCalendarioDiaDetalhes((prev) => {
          const old = prev[diaIso] || {
            falta: null as 'S' | null,
            atestado: null as 'S' | null,
            folga: null as 'S' | null,
            justificativa: '',
          };
          if (next === 0) {
            return {
              ...prev,
              [diaIso]: {
                ...old,
                falta: 'S',
                folga: null,
              },
            };
          }
          if (next === 1) {
            return {
              ...prev,
              [diaIso]: {
                ...old,
                falta: null,
              },
            };
          }
          const merged = { ...old, falta: null as 'S' | null };
          const tudoLimpo =
            merged.falta !== 'S' &&
            merged.atestado !== 'S' &&
            merged.folga !== 'S' &&
            !(merged.justificativa || '').trim() &&
            !merged.atestadoImagem &&
            !merged.entradaEm &&
            !merged.saidaAlmocoEm &&
            !merged.voltaAlmocoEm &&
            !merged.saidaExpedienteEm;
          if (tudoLimpo) {
            const n = { ...prev };
            delete n[diaIso];
            return n;
          }
          return { ...prev, [diaIso]: merged };
        });
      } catch (e) {
        setEscalaCalendarioPresencaDias(snapshot);
        Alert.alert('Presença', e instanceof Error ? e.message : 'Não foi possível salvar.');
      } finally {
        setEscalaPresencaRapidaSaving(null);
      }
    },
    [
      currentClienteId,
      escalaCalendarioColaborador,
      escalaCalendarioPresencaDias,
      podeAtalhosGestaoCalendarioPresenca,
    ]
  );

  const executarSwipeCalendarioDia = useCallback(
    async (
      diaIso: string,
      direction: 'left' | 'right',
      swipeable: { close: () => void } | null
    ) => {
      const fecharSwipe = () => {
        try {
          swipeable?.close();
        } catch {
          /* noop */
        }
      };
      if (currentClienteId == null || escalaCalendarioColaborador == null) {
        fecharSwipe();
        return;
      }
      if (!podeAtalhosGestaoCalendarioPresenca) {
        fecharSwipe();
        return;
      }
      const colabId = escalaCalendarioColaborador.clienteId;
      const ehProprioColaborador = colabId === currentClienteId;
      let cargoV = getCargoViewerParaGestaoPonto();
      if (!ehProprioColaborador && !cargoPodeGerirMarcacoesPontoOutros(cargoV)) {
        const loaded = await loadPerfilFuncionarioGestao();
        cargoV = (loaded ?? '').trim() || getCargoViewerParaGestaoPonto();
      }
      const subNaListaEscala = escalaEquipe.some((m) => m.id === colabId);
      const podeMarcarOutros =
        cargoPodeGerirMarcacoesPontoOutros(cargoV) ||
        (!ehProprioColaborador && subNaListaEscala && cargoHierarchyRankApp(cargoV) >= 15);
      const semFolgaProprio = ehProprioColaborador && !cargoPodeFolgaNoProprioPonto(cargoV);
      if (!ehProprioColaborador && !podeMarcarOutros) {
        Alert.alert('Calendário', 'Sem permiss\u00e3o para alterar este registro.');
        fecharSwipe();
        return;
      }

      const det = escalaCalendarioDiaDetalhes[diaIso];
      const presSit = escalaCalendarioPresencaDias[diaIso];
      let falta = det?.falta === 'S';
      if (presSit === 0) falta = true;
      else if (presSit === 1) falta = false;

      let folga = det?.folga === 'S';
      const atestadoSim = det?.atestado === 'S';

      if (direction === 'left') {
        const nextFolga = !folga;
        if (nextFolga && semFolgaProprio) {
          Alert.alert(
            'Folga',
            'Voc\u00ea n\u00e3o pode registrar folga no pr\u00f3prio dia. Use os detalhes ou pe\u00e7a a um gerente.'
          );
          fecharSwipe();
          return;
        }
        folga = nextFolga;
        if (folga) falta = false;
      } else {
        fecharSwipe();
        const jTrim = (typeof det?.justificativa === 'string' ? det.justificativa : '').trim();
        abrirPontoDiaModal(diaIso, {
          obrigarJustificativaPosSwipeJ: jTrim.length === 0,
        });
        return;
      }

      if (falta && folga) folga = false;

      const justOut = (typeof det?.justificativa === 'string' ? det.justificativa : '')
        .trim()
        .slice(0, 2000);

      setEscalaDetalheSwipeSaving(diaIso);
      try {
        const base = apiBaseUrl();
        const res = await fetchWithTimeout(
          `${base}/api/funcionarios/${currentClienteId}/ponto-dia-detalhe`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              colaboradorId: colabId,
              dia: diaIso,
              falta,
              atestado: atestadoSim,
              folga,
              justificativa: justOut,
            }),
          }
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          Alert.alert(
            'Calendário',
            typeof data.error === 'string' ? data.error : `Erro ${res.status}`
          );
          return;
        }
        setEscalaCalendarioDiaDetalhes((prev) => {
          const old = prev[diaIso] || {
            falta: null as 'S' | null,
            atestado: null as 'S' | null,
            folga: null as 'S' | null,
            justificativa: '',
          };
          const tudoLimpo =
            !falta &&
            !atestadoSim &&
            !folga &&
            justOut.length === 0 &&
            !(old.atestadoImagem && String(old.atestadoImagem).trim().length > 0);
          if (tudoLimpo) {
            const n = { ...prev };
            delete n[diaIso];
            return n;
          }
          return {
            ...prev,
            [diaIso]: {
              ...old,
              falta: falta ? 'S' : null,
              folga: folga ? 'S' : null,
              atestado: atestadoSim ? 'S' : null,
              justificativa: justOut,
            },
          };
        });
        setEscalaCalPresencaRefreshSeq((n) => n + 1);
      } catch {
        Alert.alert('Calendário', 'N\u00e3o foi poss\u00edvel salvar.');
      } finally {
        setEscalaDetalheSwipeSaving(null);
        fecharSwipe();
      }
    },
    [
      currentClienteId,
      escalaCalendarioColaborador,
      escalaCalendarioDiaDetalhes,
      escalaCalendarioPresencaDias,
      escalaEquipe,
      getCargoViewerParaGestaoPonto,
      podeAtalhosGestaoCalendarioPresenca,
    ]
  );

  const salvarPontoDiaModal = async () => {
    if (currentClienteId == null || escalaCalendarioColaborador == null || escalaPontoDiaModal == null)
      return;
    const colabId = escalaCalendarioColaborador.clienteId;
    const ehProprioColaborador = colabId === currentClienteId;
    let cargoV = getCargoViewerParaGestaoPonto();
    if (!ehProprioColaborador && !cargoPodeGerirMarcacoesPontoOutros(cargoV)) {
      const loaded = await loadPerfilFuncionarioGestao();
      cargoV = (loaded ?? '').trim() || getCargoViewerParaGestaoPonto();
    }
    const subNaListaEscala = escalaEquipe.some((m) => m.id === colabId);
    const podeMarcarOutros =
      cargoPodeGerirMarcacoesPontoOutros(cargoV) ||
      (!ehProprioColaborador && subNaListaEscala && cargoHierarchyRankApp(cargoV) >= 15);
    const semFolgaProprio = ehProprioColaborador && !cargoPodeFolgaNoProprioPonto(cargoV);
    if (!ehProprioColaborador && !podeMarcarOutros) {
      setPontoDiaError('Sem permiss\u00e3o para alterar este registro.');
      return;
    }

    if (
      escalaPontoDiaModal.obrigarJustificativaPosSwipeJ &&
      pontoDiaJustificativa.trim().length === 0
    ) {
      setPontoDiaError('Informe a justificativa para concluir o que pediu no calendário.');
      return;
    }

    setPontoDiaSaving(true);
    setPontoDiaError(null);
    try {
      const base = apiBaseUrl();
      let falta = pontoDiaFaltaSim;
      let folga = semFolgaProprio ? false : pontoDiaFolgaSim;
      if (falta && folga) folga = false;
      const body: Record<string, unknown> = {
        colaboradorId: colabId,
        dia: escalaPontoDiaModal.diaIso,
        falta,
        atestado: pontoDiaAtestadoSim,
        folga,
        justificativa: pontoDiaJustificativa.trim().slice(0, 2000),
      };
      if (pontoDiaRemoverAtestadoImagem) {
        body.atestadoImagem = null;
      } else if (pontoDiaAtestadoImagemPending) {
        body.atestadoImagem = pontoDiaAtestadoImagemPending;
      }
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/ponto-dia-detalhe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        atestadoImagem?: string | null;
      };
      if (!res.ok) {
        setPontoDiaError(typeof data.error === 'string' ? data.error : `Erro ${res.status}`);
        return;
      }
      const diaIsoSalvo = escalaPontoDiaModal.diaIso;
      const just = pontoDiaJustificativa.trim().slice(0, 2000);
      const apiTrouxeAtestadoImagem = Object.prototype.hasOwnProperty.call(data, 'atestadoImagem');
      const atestImgApi =
        apiTrouxeAtestadoImagem &&
        data.atestadoImagem != null &&
        typeof data.atestadoImagem === 'string' &&
        data.atestadoImagem.length > 0
          ? data.atestadoImagem
          : null;
      setEscalaCalendarioDiaDetalhes((prev) => {
        const old = prev[diaIsoSalvo] || {
          falta: null,
          atestado: null,
          folga: null,
          justificativa: '',
        };
        const atestadoImagemNovo = pontoDiaRemoverAtestadoImagem
          ? null
          : apiTrouxeAtestadoImagem
            ? atestImgApi
            : pontoDiaAtestadoImagemPending ?? old.atestadoImagem ?? null;
        const tudoLimpo =
          !falta && !pontoDiaAtestadoSim && !folga && just.length === 0 && !atestadoImagemNovo;
        if (tudoLimpo) {
          const next = { ...prev };
          delete next[diaIsoSalvo];
          return next;
        }
        return {
          ...prev,
          [diaIsoSalvo]: {
            ...old,
            falta: falta ? 'S' : null,
            folga: folga ? 'S' : null,
            atestado: pontoDiaAtestadoSim ? 'S' : null,
            justificativa: just,
            atestadoImagem: atestadoImagemNovo,
          },
        };
      });
      setEscalaPontoDiaModal(null);
      setPontoDiaAtestadoImagemPending(null);
      setPontoDiaRemoverAtestadoImagem(false);
      setEscalaCalPresencaRefreshSeq((n) => n + 1);
    } catch {
      setPontoDiaError('Falha ao salvar.');
    } finally {
      setPontoDiaSaving(false);
    }
  };

  const persistFuncionarioEmServico = async (value: boolean) => {
    if (currentClienteId == null) return;
    setFuncionarioEmServico(value);
    const keyEm = storageKeyFuncionarioEmServico(currentClienteId);
    try {
      await AsyncStorage.setItem(keyEm, value ? '1' : '0');
    } catch {
      /* ignore */
    }
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/status-trabalho`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusTrabalho: value ? 1 : 0 }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          pontoSyncOk?: boolean;
          pontoSyncDetail?: string;
        } | null;
        if (body && body.pontoSyncOk === false) {
          const det =
            typeof body.pontoSyncDetail === 'string' && body.pontoSyncDetail.trim().length > 0
              ? `\n\n${body.pontoSyncDetail.trim().slice(0, 500)}`
              : '';
          Alert.alert(
            'Ponto do dia',
            `O status foi salvo, mas o registro na tabela de ponto falhou.${det}`
          );
        }
        setPerfilFuncionarioGestao((p) =>
          p ? { ...p, statusTrabalho: value ? 1 : 0 } : p
        );
        /* Servidor sincroniza Entrada/Saídas em PontoEletronicoDia — atualiza lista da escala. */
        if (escalaTrabalhoVisible) void refreshEscalaListaAtual();
      } else {
        const errBody = await res.json().catch(() => ({}));
        const det =
          typeof errBody?.detail === 'string' && errBody.detail.trim().length > 0
            ? `\n\n${errBody.detail.trim().slice(0, 500)}`
            : '';
        const msg =
          typeof errBody?.error === 'string'
            ? errBody.error
            : `Não foi possível salvar (${res.status}).`;
        Alert.alert('Status de trabalho', `${msg}${det}`);
        void loadPerfilFuncionarioGestao();
      }
    } catch {
      Alert.alert(
        'Status de trabalho',
        'Sem conexão ou servidor indisponível. Tente novamente.'
      );
      void loadPerfilFuncionarioGestao();
    }
  };

  const scheduleIdleLogout = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!isLoggedIn) return;
    if (isClienteCadastroFuncionario) return;
    const now = Date.now();
    const dueIn = Math.max(0, SESSION_IDLE_TIMEOUT_MS - (now - lastInteractionAtRef.current));
    idleTimerRef.current = setTimeout(() => {
      if (skipIdleLogoutFuncionarioRef.current) return;
      const idleFor = Date.now() - lastInteractionAtRef.current;
      if (isLoggedIn && idleFor >= SESSION_IDLE_TIMEOUT_MS) {
        signOut('Sua sess\u00e3o expirou por inatividade (5 minutos).');
      } else {
        scheduleIdleLogout();
      }
    }, dueIn + 50);
  };

  const markInteraction = () => {
    lastInteractionAtRef.current = Date.now();
    scheduleIdleLogout();
  };

  useEffect(() => {
    scheduleIdleLogout();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [isLoggedIn, isClienteCadastroFuncionario]);

  useEffect(() => {
    const onAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundAtRef.current = Date.now();
        return;
      }
      if (nextState === 'active') {
        const bgAt = backgroundAtRef.current;
        backgroundAtRef.current = null;
        if (
          isLoggedIn &&
          bgAt &&
          !skipIdleLogoutFuncionarioRef.current &&
          Date.now() - bgAt >= SESSION_IDLE_TIMEOUT_MS
        ) {
          signOut('Sua sess\u00e3o expirou (app ficou inativo por 5 minutos).');
          return;
        }
        markInteraction();
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => sub.remove();
  }, [isLoggedIn, isClienteCadastroFuncionario]);
  const mapInfoImageCandidates = selectedMapLocal ? mapLocalImageCandidates(selectedMapLocal) : [];
  const mapInfoImageUri =
    mapInfoImageCandidates.length > 0
      ? mapInfoImageCandidates[Math.min(mapInfoImageAttempt, mapInfoImageCandidates.length - 1)]
      : '';
  const mapLocaisLoadedRef = useRef(false);
  const [mapLegendVisible, setMapLegendVisible] = useState(false);
  const [mapLegendOpenCategory, setMapLegendOpenCategory] = useState<MapHotspotCategoria | null>(null);
  /** Pisca suave nas bordas dos pins (compartilhado, mesmo ritmo). */
  const mapHotspotPulseOpacity = useRef(new Animated.Value(0.48)).current;
  /** Brilho que expande e some — mesma cor do raio por categoria. */
  const mapHotspotShineScale = useRef(new Animated.Value(1)).current;
  const mapHotspotShineOpacity = useRef(new Animated.Value(0.42)).current;
  /** Movimento "moeda flutuando": sobe/desce + giro + leve expansão. */
  const mapCoinFloatY = useRef(new Animated.Value(0)).current;
  const mapCoinRotate = useRef(new Animated.Value(0)).current;
  const mapCoinScale = useRef(new Animated.Value(1)).current;

  const screenWidth = Dimensions.get('window').width;
  const screenHeight = Dimensions.get('window').height;
  /** Ícone do app no centro do splash (alinhado ao app.json / ícone). */
  const splashAppIconSize = Math.min(168, Math.round(screenWidth * 0.42));
  const cardWidth = screenWidth - 44;
  /**
   * FAB engrenagem (Configurações) na aba Perfil — posição em relação ao canto inferior direito.
   *
   * Ajuste aqui:
   * - PROFILE_CONFIG_FAB_SIZE: tamanho do círculo (largura/altura).
   * - profileConfigFabRight: distância da borda direita; aumente o valor para ir mais à esquerda.
   *   A fórmula usa (1/8)*largura para alinhar à coluna do ícone Perfil; troque 1/8 por outra fração ou use pixels fixos, ex.: insets.right + 12.
   * - profileNavIconCenterFromBottom: referência vertical do centro dos ícones da barra; o +24 acompanha o raio do bubble (~48/2).
   * - O +32 somado em profileConfigFabBottom sobe o FAB acima da barra; diminua (ex. +20) para baixar, aumente para subir.
   */
  const PROFILE_CONFIG_FAB_SIZE = 40;
  const layoutNavInnerW = screenWidth - insets.left - insets.right;
  const profileConfigFabRight = Math.max(
    4,
    layoutNavInnerW * (1 / 11) - PROFILE_CONFIG_FAB_SIZE / 2
  );
  const profileNavIconCenterFromBottom = Math.max(insets.bottom, 10) + 50 ;
  const profileConfigFabBottom = profileNavIconCenterFromBottom + 40;
  const cocoaPattern = require('./assets/bg-cacau-pattern.png');
  /**
   * Plano de fundo da abertura (React): bokeh. O splash nativo usa `splash-native-composite.png`
   * (bokeh + icon-amusement-cs), gerado por scripts/build-splash-composite.ps1.
   */
  const splashStillImage = require('./assets/bg-splash-only.png');
  const splashAppIcon = require('./assets/icon-amusement-cs.png');
  const mapaParque = require('./assets/mapa-parque.png');
  const lojasBackground = require('./assets/lojas-bg.png');
  const atracoesBackground = require('./assets/atracoes-bg.png');
  const openMapFromHome = (categoria: MapHotspotCategoria) => {
    setSelectedMapLocal(null);
    resetMapView();
    setActiveTab('mapa');
    setMapLegendOpenCategory(categoria);
    setMapLegendVisible(true);
  };

  const carouselItems: {
    title: string;
    image: ImageSourcePropType;
    openMapCategory?: MapHotspotCategoria;
  }[] = [
    {
      title: 'Lojas',
      image: lojasBackground,
      openMapCategory: 'comida',
    },
    {
      title: 'Eventos',
      image: {
        uri: 'https://images.unsplash.com/photo-1525869811964-53594bfcb4b0?auto=format&fit=crop&w=1200&q=80',
      },
    },
    {
      title: 'Atra\u00e7\u00f5es',
      image: atracoesBackground,
      openMapCategory: 'diversao',
    },
  ];

  const hotelCarouselItems: { title: string; image: ImageSourcePropType }[] = [
    {
      title: 'Hotel Sonhos de Chocolate',
      image: {
        uri: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=1200&q=80',
      },
    },
    {
      title: 'Hotel Cacau Boulevard',
      image: {
        uri: 'https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=80',
      },
    },
  ];

  const factoryHighlightImages: ImageSourcePropType[] = [
    require('./assets/factory-chocolate-hero.png'),
  ];
  const factoryHighlightImage =
    factoryHighlightImages[Math.min(factoryImageAttempt, factoryHighlightImages.length - 1)];

  const handleSlideChange = (offsetX: number) => {
    const index = Math.round(offsetX / cardWidth);
    setActiveSlide(index);
  };

  const handleHotelSlideChange = (offsetX: number) => {
    const index = Math.round(offsetX / cardWidth);
    setActiveHotelSlide(Math.min(Math.max(index, 0), hotelCarouselItems.length - 1));
  };
  // Em Ingressos, manter navegação inferior para sempre permitir sair da tela.
  const showBottomNav = activeTab === 'ingressos' ? true : !showRegisterForm;

  const [introVisible, setIntroVisible] = useState(true);
  const introOverlayOpacity = useRef(new Animated.Value(1)).current;
  const introFelizScale = useRef(new Animated.Value(0.9)).current;
  const splashBgLoadedRef = useRef(false);
  const splashIconLoadedRef = useRef(false);
  const nativeSplashHiddenRef = useRef(false);

  const tryHideNativeSplash = useCallback(() => {
    if (nativeSplashHiddenRef.current) return;
    if (!splashBgLoadedRef.current || !splashIconLoadedRef.current) return;
    nativeSplashHiddenRef.current = true;
    requestAnimationFrame(() => {
      void SplashScreen.hideAsync();
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!nativeSplashHiddenRef.current) {
        nativeSplashHiddenRef.current = true;
        void SplashScreen.hideAsync();
      }
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!introVisible) return;
    introOverlayOpacity.setValue(1);
    introFelizScale.setValue(0.82);
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.timing(introFelizScale, {
          toValue: 2.35,
          duration: 1600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.delay(1600),
      ]),
      Animated.timing(introOverlayOpacity, {
        toValue: 0,
        duration: 320,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    anim.start(({ finished }) => {
      if (finished) setIntroVisible(false);
    });
  }, [introVisible]);

  const loadMapLocais = async () => {
    setMapLocaisLoading(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(
        `${base}/api/mapa/locais?parqueCodigo=cacau-parque`,
        { method: 'GET' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);

      const locais = Array.isArray(data?.locais) ? data.locais : [];
      setMapLocais(
        locais.map((l: any) => ({
          codigo: String(l.codigo ?? ''),
          nome: String(l.nome ?? ''),
          tipo: String(l.tipo ?? ''),
          categoria: typeof l.categoria === 'string' ? l.categoria : undefined,
          descricao: typeof l.descricao === 'string' ? l.descricao : undefined,
          classificacao: typeof l.classificacao === 'string' ? l.classificacao : undefined,
          alturaMinCm:
            l.alturaMinCm === null || l.alturaMinCm === undefined
              ? undefined
              : Number(l.alturaMinCm),
          aberto:
            l.aberto === null || l.aberto === undefined ? undefined : Boolean(l.aberto),
          tempoFilaMin:
            l.tempoFilaMin === null || l.tempoFilaMin === undefined
              ? undefined
              : Number(l.tempoFilaMin),
          imagemUrl: typeof l.imagemUrl === 'string' ? l.imagemUrl : undefined,
          iconeMapaUrl: typeof l.iconeMapaUrl === 'string' ? l.iconeMapaUrl : undefined,
          x: Number(l.x),
          y: Number(l.y),
          w: Number(l.w),
          h: Number(l.h),
        }))
      );
      mapLocaisLoadedRef.current = locais.length > 0;
    } catch (_e: unknown) {
      // Fallback: usa demo local quando API não estiver pronta.
      setMapLocais([]);
      mapLocaisLoadedRef.current = false;
    } finally {
      setMapLocaisLoading(false);
    }
  };

  const handlePullRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      if (activeTab === 'mapa') {
        mapLocaisLoadedRef.current = false;
        await loadMapLocais();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const buildProfilePhotoDataUri = async (uri: string): Promise<string> => {
    // Evita HEIC/PNG problemáticos e reduz tamanho para upload e persistência
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: PROFILE_PHOTO_TARGET_SIZE, height: PROFILE_PHOTO_TARGET_SIZE } }],
      {
        compress: PROFILE_PHOTO_TARGET_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    if (!result.base64) {
      throw new Error('Falha ao converter a imagem.');
    }
    return `data:image/jpeg;base64,${result.base64}`;
  };

  const buildAtestadoImageDataUri = async (uri: string): Promise<string> => {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: ATESTADO_IMAGE_MAX_WIDTH } }],
      {
        compress: ATESTADO_IMAGE_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );
    if (!result.base64) {
      throw new Error('Falha ao converter a imagem.');
    }
    return `data:image/jpeg;base64,${result.base64}`;
  };

  const pickAtestadoImagemParaPontoDia = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Atestado', 'Permita acesso \u00e0 galeria para anexar a imagem.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    try {
      const dataUri = await buildAtestadoImageDataUri(result.assets[0].uri);
      const sizeBytes = estimateDataUriBytes(dataUri);
      if (sizeBytes > MAX_PROFILE_PHOTO_BYTES) {
        const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
        Alert.alert(
          'Atestado',
          `A imagem ficou grande demais (${sizeMb}MB). Escolha outra ou uma foto menor.`
        );
        return;
      }
      setPontoDiaRemoverAtestadoImagem(false);
      setPontoDiaAtestadoImagemPending(dataUri);
    } catch {
      Alert.alert('Atestado', 'N\u00e3o foi poss\u00edvel processar a imagem.');
    }
  };

  const tirarFotoAtestadoPontoDiaCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Atestado', 'Permita acesso \u00e0 c\u00e2mera para fotografar o atestado.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    try {
      const dataUri = await buildAtestadoImageDataUri(result.assets[0].uri);
      const sizeBytes = estimateDataUriBytes(dataUri);
      if (sizeBytes > MAX_PROFILE_PHOTO_BYTES) {
        const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
        Alert.alert(
          'Atestado',
          `A imagem ficou grande demais (${sizeMb}MB). Escolha outra ou uma foto menor.`
        );
        return;
      }
      setPontoDiaRemoverAtestadoImagem(false);
      setPontoDiaAtestadoImagemPending(dataUri);
    } catch {
      Alert.alert('Atestado', 'N\u00e3o foi poss\u00edvel processar a imagem.');
    }
  };

  const uploadProfilePhoto = async (photoDataUri: string): Promise<string | null> => {
    if (!currentClienteId) return null;
    const sizeBytes = estimateDataUriBytes(photoDataUri);
    if (sizeBytes > MAX_PROFILE_PHOTO_BYTES) {
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
      Alert.alert('Foto', `A imagem ficou grande demais ap\u00f3s processar (${sizeMb}MB). Escolha uma foto menor.`);
      return null;
    }
    try {
      const base = apiBaseUrl();
      const doRequest = () =>
        fetchWithTimeout(
          `${base}/api/clientes/${currentClienteId}/foto`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fotoPerfil: photoDataUri }),
          },
          PHOTO_UPLOAD_TIMEOUT_MS
        );
      let res = await doRequest();
      if (!res.ok && res.status >= 500) {
        // retry 1x para falhas momentâneas de rede/servidor
        res = await doRequest();
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 413) {
          Alert.alert('Foto', 'A imagem ficou grande demais. Escolha uma foto menor.');
          return null;
        }
        const detail = typeof data?.detail === 'string' ? `\n${data.detail}` : '';
        Alert.alert('Foto', `${data.error || `Erro ${res.status}`}${detail}`);
        return null;
      }
      const foto = typeof data?.cliente?.fotoPerfil === 'string' ? data.cliente.fotoPerfil : '';
      return foto || null;
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Foto',
        aborted ? 'O servidor demorou para responder ao salvar a foto.' : 'N\u00e3o foi poss\u00edvel salvar a foto no servidor.'
      );
      return null;
    }
  };

  const pickProfilePhotoFromCamera = async () => {
    setPhotoPickerVisible(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Foto', 'Permita acesso \u00e0 c\u00e2mera para tirar a foto.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      base64: true,
      quality: 0.55,
    });
    if (!result.canceled && result.assets && result.assets[0]) {
      const asset = result.assets[0];
      try {
        const dataUri = await buildProfilePhotoDataUri(asset.uri);
        const savedPhoto = await uploadProfilePhoto(dataUri);
        if (savedPhoto) setProfilePhotoUri(savedPhoto);
      } catch {
        Alert.alert('Foto', 'A foto foi selecionada, mas n\u00e3o foi poss\u00edvel gravar no banco.');
      }
    }
  };

  const pickProfilePhotoFromGallery = async () => {
    setPhotoPickerVisible(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Foto', 'Permita acesso \u00e0 galeria para selecionar a foto.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      base64: true,
      quality: 0.55,
    });
    if (!result.canceled && result.assets && result.assets[0]) {
      const asset = result.assets[0];
      try {
        const dataUri = await buildProfilePhotoDataUri(asset.uri);
        const savedPhoto = await uploadProfilePhoto(dataUri);
        if (savedPhoto) setProfilePhotoUri(savedPhoto);
      } catch {
        Alert.alert('Foto', 'A foto foi selecionada, mas n\u00e3o foi poss\u00edvel gravar no banco.');
      }
    }
  };

  const pickProfilePhotoFromFiles = async () => {
    setPhotoPickerVisible(false);
    const result = await DocumentPicker.getDocumentAsync({
      type: 'image/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (!result.canceled && result.assets && result.assets[0]?.uri) {
      const asset = result.assets[0];
      const dataUri = await buildProfilePhotoDataUri(asset.uri);
      const savedPhoto = await uploadProfilePhoto(dataUri);
      if (savedPhoto) setProfilePhotoUri(savedPhoto);
    }
  };

  const openProfilePhotoPicker = () => {
    setPhotoPickerVisible(true);
  };

  const savePersonalInfo = async () => {
    if (profileApelido.trim().length < 2) {
      Alert.alert('Apelido', 'Informe um apelido com pelo menos 2 caracteres.');
      return;
    }
    if (!isValidEmailClient((profileEmail || email).trim())) {
      Alert.alert('E-mail', 'Verifique o formato do e-mail.');
      return;
    }
    setProfileSaving(true);
    try {
      const base = apiBaseUrl();
      const mailContato = (profileEmail || email).trim();
      const payload = {
        id: currentClienteId,
        email: mailContato,
        nome: profileNome.trim(),
        sobrenome: profileSobrenome.trim(),
        apelido: profileApelido.trim(),
      };
      let res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId ?? 0}/perfil-pessoal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        // Compatibilidade: alguns ambientes podem não ter a rota por ID ativa.
        res = await fetchWithTimeout(`${base}/api/clientes/perfil-pessoal`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(() => ({}));
      }
      if (!res.ok) {
        Alert.alert('Perfil', data.error || `Erro ${res.status}`);
        return;
      }
      const apelido = typeof data?.cliente?.apelido === 'string' ? data.cliente.apelido.trim() : '';
      if (apelido) setUserNome(apelido);
      if (data?.cliente?.id !== null && data?.cliente?.id !== undefined) {
        setCurrentClienteId(Number(data.cliente.id));
      }
      const mailSalvo =
        typeof data?.cliente?.email === 'string' ? data.cliente.email.trim() : mailContato;
      setProfileEmail(mailSalvo);
      setEmail(mailSalvo);
      setProfileModalVisible(false);
      Alert.alert('Perfil', 'Informa\u00e7\u00f5es pessoais salvas com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'N\u00e3o foi poss\u00edvel salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const saveContactInfo = async () => {
    if (!currentClienteId) {
      Alert.alert('Contato', 'Conta n\u00e3o identificada. Entre novamente.');
      return;
    }
    if (!isValidEmailClient(profileEmail)) {
      Alert.alert('E-mail', 'Verifique o formato do e-mail.');
      return;
    }
    setProfileSaving(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}/contato`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefone: profileTelefone.trim(),
          email: profileEmail.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Alert.alert('Contato', data.error || `Erro ${res.status}`);
        return;
      }
      setProfileTelefone(typeof data?.cliente?.telefone === 'string' ? data.cliente.telefone : '');
      setProfileEmail(typeof data?.cliente?.email === 'string' ? data.cliente.email : profileEmail.trim());
      setEmail(typeof data?.cliente?.email === 'string' ? data.cliente.email : profileEmail.trim());
      setContactModalVisible(false);
      Alert.alert('Contato', 'Informa\u00e7\u00f5es de contato salvas com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'N\u00e3o foi poss\u00edvel salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const savePasswordInfo = async () => {
    if (!currentClienteId) {
      Alert.alert('Senha', 'Conta n\u00e3o identificada. Entre novamente.');
      return;
    }
    if (!currentPassword || !newPassword) {
      Alert.alert('Senha', 'Informe a senha atual e a nova senha.');
      return;
    }
    if (currentPassword === newPassword) {
      Alert.alert('Senha', 'A nova senha deve ser diferente da atual.');
      return;
    }
    if (
      newPassword.length < 8 ||
      !/[a-z]/.test(newPassword) ||
      !/[A-Z]/.test(newPassword) ||
      !/\d/.test(newPassword) ||
      !/[^A-Za-z0-9]/.test(newPassword)
    ) {
      Alert.alert(
        'Senha',
        'M\u00ednimo 8 caracteres: mai\u00fascula, min\u00fascula, n\u00famero e caractere especial.'
      );
      return;
    }
    setProfileSaving(true);
    try {
      const base = apiBaseUrl();
      let res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}/senha`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: currentClienteId,
          email: profileEmail || email,
          senhaAtual: currentPassword,
          novaSenha: newPassword,
        }),
      });
      let data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        res = await fetchWithTimeout(`${base}/api/clientes/senha`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: currentClienteId,
            email: profileEmail || email,
            senhaAtual: currentPassword,
            novaSenha: newPassword,
          }),
        });
        data = await res.json().catch(() => ({}));
      }
      if (!res.ok) {
        Alert.alert('Senha', data.error || `Erro ${res.status}`);
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setCurrentPasswordVisible(false);
      setNewPasswordVisible(false);
      setPasswordModalVisible(false);
      Alert.alert('Senha', 'Senha atualizada com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'N\u00e3o foi poss\u00edvel salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const loadAddressInfo = async () => {
    if (!currentClienteId) {
      setAddressRua('');
      setAddressBairro('');
      setAddressPais('');
      setAddressCep('');
      setAddressNumero('');
      return;
    }
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}/endereco`, {
        method: 'GET',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const endereco = data?.endereco || {};
      setAddressRua(typeof endereco.rua === 'string' ? endereco.rua : '');
      setAddressBairro(typeof endereco.bairro === 'string' ? endereco.bairro : '');
      setAddressPais(typeof endereco.pais === 'string' ? endereco.pais : '');
      setAddressCep(typeof endereco.cep === 'string' ? endereco.cep : '');
      setAddressNumero(typeof endereco.numero === 'string' ? endereco.numero : '');
    } catch {
      // Se falhar, mantém campos atuais.
    }
  };

  const saveAddressInfo = async () => {
    if (!currentClienteId) {
      Alert.alert('Endere\u00e7o', 'Conta n\u00e3o identificada. Entre novamente.');
      return;
    }
    setProfileSaving(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}/endereco`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rua: addressRua.trim(),
          bairro: addressBairro.trim(),
          pais: addressPais.trim(),
          cep: addressCep.trim(),
          numero: addressNumero.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Alert.alert('Endere\u00e7o', data.error || `Erro ${res.status}`);
        return;
      }
      setAddressModalVisible(false);
      Alert.alert('Endere\u00e7o', 'Endere\u00e7o salvo com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'N\u00e3o foi poss\u00edvel salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!currentClienteId) {
      Alert.alert('Conta', 'Conta n\u00e3o identificada. Entre novamente.');
      return;
    }
    setDeleteBusy(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Alert.alert('Conta', data.error || `Erro ${res.status}`);
        return;
      }

      setDeleteConfirmVisible(false);
      setDeleteDoneVisible(true);
      setIsLoggedIn(false);
      setLoggedInAsReturning(false);
      setWelcomeReturnModalVisible(false);
      setProfilePhotoUri(null);
      setUserNome('');
      setCurrentClienteId(null);
      setProfileNome('');
      setProfileSobrenome('');
      setProfileApelido('');
      setProfileTelefone('');
      setProfileEmail('');
      setCurrentPassword('');
      setNewPassword('');
      setCurrentPasswordVisible(false);
      setNewPasswordVisible(false);
      setShowRegisterForm(false);
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'N\u00e3o foi poss\u00edvel excluir a conta agora.'
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleEntrar = async () => {
    const mail = email.trim();
    const pwd = password.trim();

    if (!mail) {
      Alert.alert('E-mail', 'Informe o e-mail.');
      return;
    }
    if (!isValidEmailClient(mail)) {
      Alert.alert('E-mail incorreto', 'Verifique o formato do e-mail.');
      return;
    }
    if (!pwd) {
      Alert.alert('Senha', 'Informe a senha.');
      return;
    }

    setAuthBusy(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/auth/entrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ email: mail, password: pwd }),
      });
      const { raw, data } = await readApiJsonResponse(res);
      if (!res.ok && !data.error && raw.trim().length > 0) {
        Alert.alert(
          'Login',
          `A API n\u00e3o respondeu em JSON (HTTP ${res.status}). Verifique se o endere\u00e7o est\u00e1 correto e se o firewall do Windows permite a porta 3000.\n\nURL usada: ${base}\n\n(${raw.slice(0, 280).trim()}${raw.length > 280 ? '\u2026' : ''})`
        );
        return;
      }
      if (res.status === 404) {
        Alert.alert('Cadastro', data.error || 'E-mail n\u00e3o existe');
        setShowRegisterForm(true);
        return;
      }
      if (res.status === 400) {
        Alert.alert('E-mail', data.error || 'E-mail incorreto');
        return;
      }
      if (res.status === 401) {
        Alert.alert('Login', data.error || 'Senha incorreta');
        return;
      }
      if (!res.ok) {
        const detail =
          typeof data.detail === 'string' && data.detail.trim() ? `\n\n${data.detail.trim()}` : '';
        const hint =
          typeof data.hint === 'string' && data.hint.trim() ? `\n\n${data.hint.trim()}` : '';
        Alert.alert('Login', `${data.error || `Erro ${res.status}`}${detail}${hint}`);
        return;
      }
      const cli = data.cliente;
      const apelidoLogin =
        typeof cli?.apelido === 'string'
          ? cli.apelido.trim()
          : typeof cli?.nome === 'string'
            ? cli.nome.trim()
            : '';
      setUserNome(apelidoLogin);
      setCurrentClienteId(
        cli?.id === null || cli?.id === undefined ? null : Number(cli.id)
      );
      setProfileNome(typeof cli?.nome === 'string' ? cli.nome : '');
      setProfileSobrenome(typeof cli?.sobrenome === 'string' ? cli.sobrenome : '');
      setProfileApelido(
        typeof cli?.apelido === 'string'
          ? cli.apelido
          : typeof cli?.nome === 'string'
            ? cli.nome
            : ''
      );
      setProfilePhotoUri(
        typeof cli?.fotoPerfil === 'string' && cli.fotoPerfil.trim().length > 0
          ? cli.fotoPerfil
          : null
      );
      setProfileTelefone(typeof cli?.telefone === 'string' ? cli.telefone : '');
      const emailConta =
        typeof cli?.email === 'string' ? cli.email.trim() : mail;
      setEmail(emailConta);
      setProfileEmail(emailConta);
      setTelefone(typeof cli?.telefone === 'string' ? cli.telefone : '');
      setLoggedInAsReturning(true);
      setIsLoggedIn(true);
      setAuthLoginMethod('email');
      const marcouFuncionario = Boolean(cli?.funcionario);
      setIsClienteCadastroFuncionario(marcouFuncionario);
      setIsFuncionarioAtivo(
        marcouFuncionario && Number(cli?.funcionarioAtivo ? 1 : 0) === 1
      );
      aplicarTelaInicialPosLogin(marcouFuncionario);
      await aplicarStatusTrabalhoDoClienteRespostaAuth(cli);
      setShowRegisterForm(false);
      setPassword('');
      setNomeCompleto('');
      setDataNascimento('');
      setTelefone('');
      setCpf('');
      setWelcomeReturnModalVisible(!marcouFuncionario);
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      const base = apiBaseUrl();
      const tech =
        e instanceof Error ? e.message.trim() : typeof e === 'string' ? e.trim() : '';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted
          ? `O servidor n\u00e3o respondeu em ${API_FETCH_TIMEOUT_MS / 1000}s.\n\n\u2022 Backend: npm start em choco-app/backend\n\u2022 URL atual: ${base}\n\u2022 Celular: mesmo Wi\u2011Fi do PC; no firewall do Windows, permita Node na porta 3000\n\u2022 Emulador Android: use http://10.0.2.2:3000 (retire apiUrl fixo do app.json em dev, se precisar).`
          : `N\u00e3o foi poss\u00edvel contactar ${base}.${tech ? `\n\nDetalhe: ${tech}` : ''}\n\n\u2022 Mesmo Wi\u2011Fi que o PC e backend a correr (porta 3000)\n\u2022 Firewall do Windows: permitir Node na porta 3000\n\u2022 APK: a URL \u00e9 fixa no build. Refa\u00e7a o build com EXPO_PUBLIC_API_URL=http://IP_DO_PC:3000 (ver app.config.js), ou use um servidor na Internet (HTTPS).`
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleCadastro = async () => {
    const mail = email.trim();
    const nextErrors: RegisterErrors = {};
    if (!isValidEmailClient(mail)) {
      nextErrors.email = 'Verifique o formato do e-mail.';
    }
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/\d/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      nextErrors.password = 'M\u00ednimo 8 caracteres: mai\u00fascula, min\u00fascula, n\u00famero e especial.';
    }
    if (nomeCompleto.trim().length < 2) {
      nextErrors.nomeCompleto = 'Informe como quer ser chamado (m\u00ednimo 2 caracteres).';
    }
    const dataNascimentoIso = parseDataNascimentoBrToIso(dataNascimento);
    if (!dataNascimentoIso) {
      nextErrors.dataNascimento =
        'Informe a data completa: dia, m\u00eas e ano (DD/MM/AAAA).';
    }

    const cpfDigits = cpf.replace(/\D/g, '');
    if (cpfDigits.length > 0 && (cpfDigits.length !== 11 || !isCpfValid(cpfDigits))) {
      nextErrors.cpf = 'Informe os 11 d\u00edgitos de um CPF v\u00e1lido ou deixe em branco.';
    }

    if (Object.keys(nextErrors).length > 0) {
      setRegisterErrors(nextErrors);
      Alert.alert('Cadastro', 'Existem campos inv\u00e1lidos. Corrija os campos em vermelho.');
      return;
    }
    setRegisterErrors({});

    setAuthBusy(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/auth/cadastro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: mail,
          password,
          nome: nomeCompleto.trim(),
          dataNascimento: dataNascimentoIso,
          telefone: telefone.trim(),
          documento: cpfDigits.length === 11 ? cpfDigits : '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          data.error || `Erro ${res.status}`;
        const extra =
          typeof data.detail === 'string' && data.detail.length > 0
            ? `\n\nDetalhe: ${data.detail}`
            : '';
        Alert.alert('Cadastro', `${msg}${extra}`);
        return;
      }
      setUserNome(
        typeof data.cliente?.apelido === 'string'
          ? data.cliente.apelido.trim()
          : nomeCompleto.trim()
      );
      setCurrentClienteId(
        data?.cliente?.id === null || data?.cliente?.id === undefined ? null : Number(data.cliente.id)
      );
      setProfileNome(typeof data.cliente?.nome === 'string' ? data.cliente.nome : '');
      setProfileSobrenome(typeof data.cliente?.sobrenome === 'string' ? data.cliente.sobrenome : '');
      setProfileApelido(
        typeof data.cliente?.apelido === 'string' ? data.cliente.apelido : nomeCompleto.trim()
      );
      setProfilePhotoUri(
        typeof data.cliente?.fotoPerfil === 'string' && data.cliente.fotoPerfil.trim().length > 0
          ? data.cliente.fotoPerfil
          : null
      );
      setProfileTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : telefone.trim());
      setProfileEmail(typeof data.cliente?.email === 'string' ? data.cliente.email : mail);
      setTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : telefone.trim());
      setLoggedInAsReturning(false);
      setIsLoggedIn(true);
      setAuthLoginMethod('email');
      const marcouNovo = Boolean(data?.cliente?.funcionario);
      setIsClienteCadastroFuncionario(marcouNovo);
      setIsFuncionarioAtivo(
        marcouNovo && Number(data?.cliente?.funcionarioAtivo ? 1 : 0) === 1
      );
      aplicarTelaInicialPosLogin(marcouNovo);
      await aplicarStatusTrabalhoDoClienteRespostaAuth(data.cliente);
      setShowRegisterForm(false);
      setPassword('');
      setNomeCompleto('');
      setDataNascimento('');
      setTelefone('');
      setCpf('');
      Alert.alert('Conta criada', 'Seus dados foram salvos. Bem-vindo!');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted
          ? 'Servidor n\u00e3o respondeu a tempo. Inicie o backend e tente de novo.'
          : 'N\u00e3o foi poss\u00edvel concluir o cadastro.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const openFuncionarioSetupAuth = () => {
    setFuncionarioAdminPass('');
    setFuncionarioAuthPassError('');
    setFuncionarioAuthVisible(true);
  };

  const closeFuncionarioAuth = () => {
    setFuncionarioAuthPassError('');
    setFuncionarioAuthVisible(false);
  };

  const confirmFuncionarioAuth = async () => {
    if (!currentClienteId) {
      Alert.alert('Funcionário', 'Faça login novamente para continuar.');
      return;
    }
    if (funcionarioAdminPass.trim() !== '123') {
      setFuncionarioAuthPassError('Senha incorreta, contate seu Gerente');
      return;
    }
    setFuncionarioAuthPassError('');
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/perfil`, {
        method: 'GET',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.perfil) {
        const s = typeof data.perfil.setor === 'string' ? data.perfil.setor.trim() : '';
        const c = typeof data.perfil.cargo === 'string' ? data.perfil.cargo.trim() : '';
        const n = typeof data.perfil.nivel === 'string' ? data.perfil.nivel.trim() : '';
        funcionarioPerfilJaExistiaRef.current = s !== '' || c !== '' || n !== '';
        setFuncionarioSetor(s);
        setFuncionarioCargo(c);
        setFuncionarioNivel(n);
      } else {
        funcionarioPerfilJaExistiaRef.current = false;
      }
      setFuncionarioAuthPassError('');
      setFuncionarioAuthVisible(false);
      setFuncionarioProfileVisible(true);
      void loadPerfilFuncionarioGestao();
    } catch {
      funcionarioPerfilJaExistiaRef.current = false;
      setFuncionarioAuthPassError('');
      setFuncionarioAuthVisible(false);
      setFuncionarioProfileVisible(true);
      void loadPerfilFuncionarioGestao();
    }
  };

  const saveFuncionarioProfile = async () => {
    if (!currentClienteId) {
      Alert.alert('Funcionário', 'Cliente inválido.');
      return;
    }
    if (!funcionarioSetor.trim() || !funcionarioCargo.trim() || !funcionarioNivel.trim()) {
      Alert.alert('Funcionário', 'Preencha setor, cargo e nível.');
      return;
    }
    setFuncionarioSaving(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/funcionarios/${currentClienteId}/perfil`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminPassword: funcionarioAdminPass.trim(),
          setor: funcionarioSetor.trim(),
          cargo: funcionarioCargo.trim(),
          nivel: funcionarioNivel.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Alert.alert('Funcionário', data.error || `Erro ${res.status}`);
        return;
      }
      setIsFuncionarioAtivo(true);
      setIsClienteCadastroFuncionario(true);
      setFuncionarioProfileVisible(false);
      void loadPerfilFuncionarioGestao();
      Alert.alert(
        funcionarioPerfilJaExistiaRef.current ? 'Cadastro alterado' : 'Cadastro concluído',
        funcionarioPerfilJaExistiaRef.current
          ? 'Os dados do funcionário foram atualizados.'
          : 'Seu cadastro de funcionário foi registrado.'
      );
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível salvar agora.'
      );
    } finally {
      setFuncionarioSaving(false);
    }
  };

  const sendGoogleIdToken = async (idToken: string) => {
    setAuthBusy(true);
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `Erro ${res.status}`;
        const extra =
          typeof data.detail === 'string' && data.detail.length > 0
            ? `\n\nDetalhe: ${data.detail}`
            : '';
        Alert.alert('Google', `${msg}${extra}`);
        return;
      }
      const apelidoG =
        typeof data.cliente?.apelido === 'string'
          ? data.cliente.apelido.trim()
          : typeof data.cliente?.nome === 'string'
            ? data.cliente.nome.trim()
            : '';
      setUserNome(apelidoG);
      setCurrentClienteId(
        data?.cliente?.id === null || data?.cliente?.id === undefined ? null : Number(data.cliente.id)
      );
      setProfileNome(typeof data.cliente?.nome === 'string' ? data.cliente.nome : '');
      setProfileSobrenome(typeof data.cliente?.sobrenome === 'string' ? data.cliente.sobrenome : '');
      setProfileApelido(
        typeof data.cliente?.apelido === 'string'
          ? data.cliente.apelido
          : typeof data.cliente?.nome === 'string'
            ? data.cliente.nome
            : ''
      );
      setProfilePhotoUri(
        typeof data.cliente?.fotoPerfil === 'string' && data.cliente.fotoPerfil.trim().length > 0
          ? data.cliente.fotoPerfil
          : null
      );
      setProfileTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : '');
      const resolvedEmail =
        typeof data.cliente?.email === 'string' ? data.cliente.email.trim() : '';
      setEmail(resolvedEmail);
      setProfileEmail(resolvedEmail);
      setTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : '');
      setShowRegisterForm(false);
      setPassword('');
      setNomeCompleto('');
      setDataNascimento('');
      setCpf('');
      setRegisterErrors({});
      setLoggedInAsReturning(!data.criado);
      setIsLoggedIn(true);
      setAuthLoginMethod('google');
      const ehFuncGoogle = Boolean(data?.cliente?.funcionario);
      setIsClienteCadastroFuncionario(ehFuncGoogle);
      setIsFuncionarioAtivo(
        ehFuncGoogle && Number(data?.cliente?.funcionarioAtivo ? 1 : 0) === 1
      );
      aplicarTelaInicialPosLogin(ehFuncGoogle);
      await aplicarStatusTrabalhoDoClienteRespostaAuth(data.cliente);
      if (data.criado) {
        Alert.alert('Conta criada com Google', 'Seus dados foram salvos. Bem-vindo!');
      } else {
        setWelcomeReturnModalVisible(!ehFuncGoogle);
      }
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conex\u00e3o',
        aborted ? 'Servidor n\u00e3o respondeu a tempo.' : 'Falha ao enviar o token para o servidor.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const lastGoogleIdTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const r = googleAuth?.response;
    if (!r || r.type !== 'success') return;

    const idToken =
      r.authentication?.idToken ??
      (typeof r.params?.id_token === 'string' ? r.params.id_token : '');

    if (!idToken) {
      Alert.alert(
        'Google',
        'N\u00e3o recebemos o id_token. No Google Cloud: crie credenciais OAuth (Web + Android e, no iPhone, iOS), preencha app.json \u2192 extra e reinicie o app. No backend, defina GOOGLE_CLIENT_ID (Web) e GOOGLE_ANDROID_CLIENT_ID no .env.'
      );
      return;
    }
    if (lastGoogleIdTokenRef.current === idToken) return;
    lastGoogleIdTokenRef.current = idToken;
    void sendGoogleIdToken(idToken);
  }, [googleAuth?.response]);

  useEffect(() => {
    if (activeTab !== 'mapa') return;
    if (mapLocaisLoadedRef.current) return;
    void loadMapLocais();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'mapa') {
      mapHotspotPulseOpacity.setValue(0.48);
      mapHotspotShineScale.setValue(1);
      mapHotspotShineOpacity.setValue(0.42);
      mapCoinRotate.setValue(0);
      return;
    }
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(mapHotspotPulseOpacity, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(mapHotspotPulseOpacity, {
          toValue: 0.48,
          duration: 900,
          useNativeDriver: true,
        }),
      ])
    );
    const dissipateMs = 1250;
    const shineLoop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(mapHotspotShineScale, {
            toValue: 1.78,
            duration: dissipateMs,
            useNativeDriver: true,
          }),
          Animated.timing(mapHotspotShineOpacity, {
            toValue: 0,
            duration: dissipateMs,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(mapHotspotShineScale, {
            toValue: 1,
            duration: 0,
            useNativeDriver: true,
          }),
          Animated.timing(mapHotspotShineOpacity, {
            toValue: 0.42,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ])
    );
    mapCoinRotate.setValue(0);
    const coinRotateLoop = Animated.loop(
      Animated.timing(mapCoinRotate, {
        toValue: 1,
        duration: 4200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true }
    );
    pulseLoop.start();
    shineLoop.start();
    coinRotateLoop.start();
    return () => {
      pulseLoop.stop();
      shineLoop.stop();
      coinRotateLoop.stop();
      mapHotspotPulseOpacity.setValue(0.48);
      mapHotspotShineScale.setValue(1);
      mapHotspotShineOpacity.setValue(0.42);
      mapCoinRotate.setValue(0);
    };
  }, [activeTab]);

  useEffect(() => {
    setMapInfoImageAttempt(0);
  }, [selectedMapLocal?.codigo, selectedMapLocal?.imagemUrl]);

  const handleGooglePress = async () => {
    if (!googleAuth) {
      Alert.alert(
        'Google',
        Platform.OS === 'ios'
          ? 'Preencha em app.json \u2192 extra: googleWebClientId (cliente OAuth Web) e googleIosClientId (cliente OAuth iOS), no mesmo projeto do Google Cloud. No backend (.env), GOOGLE_CLIENT_ID deve ser o ID do cliente Web.'
          : 'Preencha em app.json \u2192 extra: googleWebClientId e googleAndroidClientId (com SHA-1 do app no Google Cloud). No backend (.env): GOOGLE_CLIENT_ID (Web) e GOOGLE_ANDROID_CLIENT_ID. Reinicie o Expo ap\u00f3s salvar.'
      );
      return;
    }
    setAuthBusy(true);
    try {
      const result = await googleAuth.promptAsync({ showInRecents: true });
      if (result.type === 'cancel' || result.type === 'dismiss') {
        Alert.alert('Google', 'Login com Google cancelado.');
      } else if (result.type === 'error') {
        Alert.alert('Google', 'Falha no login com Google. Verifique os Client IDs e tente novamente.');
      }
    } catch {
      Alert.alert('Google', 'N\u00e3o foi poss\u00edvel abrir a tela de login do Google.');
    } finally {
      setAuthBusy(false);
    }
  };

  const mapBottomReserve = 72 + Math.max(insets.bottom, 10);
  const homeBottomReserve = mapBottomReserve + 4;
  /** Barra chocolate superior: insets + paddings + linha de título (+ faixa um pouco mais alta). */
  const mapTopChrome = insets.top + 52;
  const mapViewportWidth = screenWidth;
  const mapViewportHeight = screenHeight - mapTopChrome - mapBottomReserve;
  const mapBaseSize = mapViewportHeight;
  const mapScale = useRef(new Animated.Value(1)).current;
  const mapTranslate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const currentScaleRef = useRef(1);
  const currentTranslateRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef(1);

  const clampMapTranslate = (x: number, y: number, scale: number) => {
    const contentWidth = mapBaseSize * scale;
    const contentHeight = mapBaseSize * scale;
    const maxX = Math.max(0, (contentWidth - mapViewportWidth) / 2);
    const maxY = Math.max(0, (contentHeight - mapViewportHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  const resetMapView = () => {
    pinchStartDistanceRef.current = null;
    pinchStartScaleRef.current = 1;
    currentScaleRef.current = 1;
    currentTranslateRef.current = { x: 0, y: 0 };
    mapScale.setValue(1);
    mapTranslate.setValue({ x: 0, y: 0 });
  };

  const zoomToLocal = (local: MapLocal) => {
    // Zoom moderado (não tão alto quanto o anterior), para não "estourar" o mapa.
    const targetScale = 2.0;
    const cx = (local.x + local.w / 2) * mapBaseSize;
    const cy = (local.y + local.h / 2) * mapBaseSize;

    // Tenta manter o ícone visível enquanto o usuário lê a "sheet" de informações.
    // Para locais perto das bordas, o clamp evita quebrar o layout (fica o mais central possível).
    const focusCenterY = mapViewportHeight * 0.38;

    const tx = mapViewportWidth / 2 + (mapBaseSize * targetScale) / 2 - cx * targetScale;
    const ty = focusCenterY + (mapBaseSize * targetScale) / 2 - cy * targetScale;

    const clamped = clampMapTranslate(tx, ty, targetScale);
    currentScaleRef.current = targetScale;
    currentTranslateRef.current = clamped;
    mapScale.setValue(targetScale);
    mapTranslate.setValue(clamped);
  };

  const mapPanResponder = useRef(
    PanResponder.create({
      // Não capturar o toque no início para não bloquear os botões/press no mapa.
      onStartShouldSetPanResponder: () => false,
      // Só capturar quando houver movimento suficiente (ou pinch com 2+ dedos).
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length >= 2) return true;
        return Math.abs(gestureState.dx) + Math.abs(gestureState.dy) > 6;
      },
      onPanResponderGrant: () => {
        panStartRef.current = { ...currentTranslateRef.current };
        pinchStartDistanceRef.current = null;
      },
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length >= 2) {
          const [t1, t2] = touches;
          const dx = t2.pageX - t1.pageX;
          const dy = t2.pageY - t1.pageY;
          const distance = Math.hypot(dx, dy);

          if (!pinchStartDistanceRef.current) {
            pinchStartDistanceRef.current = distance;
            pinchStartScaleRef.current = currentScaleRef.current;
            return;
          }

          const nextScale = Math.max(
            1,
            Math.min(4, pinchStartScaleRef.current * (distance / pinchStartDistanceRef.current))
          );
          currentScaleRef.current = nextScale;
          mapScale.setValue(nextScale);

          // Reajusta o offset atual aos novos limites após zoom.
          const clamped = clampMapTranslate(
            currentTranslateRef.current.x,
            currentTranslateRef.current.y,
            nextScale
          );
          currentTranslateRef.current = clamped;
          mapTranslate.setValue(clamped);
          return;
        }

        pinchStartDistanceRef.current = null;
        const next = clampMapTranslate(
          panStartRef.current.x + gestureState.dx,
          panStartRef.current.y + gestureState.dy,
          currentScaleRef.current
        );
        currentTranslateRef.current = next;
        mapTranslate.setValue(next);
      },
      onPanResponderRelease: () => {
        pinchStartDistanceRef.current = null;
        const clamped = clampMapTranslate(
          currentTranslateRef.current.x,
          currentTranslateRef.current.y,
          currentScaleRef.current
        );
        currentTranslateRef.current = clamped;
        mapTranslate.setValue(clamped);
      },
      onPanResponderTerminate: () => {
        pinchStartDistanceRef.current = null;
        const clamped = clampMapTranslate(
          currentTranslateRef.current.x,
          currentTranslateRef.current.y,
          currentScaleRef.current
        );
        currentTranslateRef.current = clamped;
        mapTranslate.setValue(clamped);
      },
    })
  ).current;

  return (
    <SafeAreaView
      style={[styles.safeArea, introVisible && styles.safeAreaSplash]}
      edges={introVisible ? ['bottom', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}
    >
      {introVisible ? (
        <Animated.View
          style={[styles.introOverlay, { opacity: introOverlayOpacity }]}
          pointerEvents="none"
        >
          <ImageBackground
            source={splashStillImage}
            style={styles.introBackdrop}
            resizeMode="cover"
            onLoadEnd={() => {
              splashBgLoadedRef.current = true;
              tryHideNativeSplash();
            }}
          />
          <View style={styles.introLogoCenterWrap} pointerEvents="none">
            <View style={styles.introSplashColumn}>
              <Animated.Image
                source={splashAppIcon}
                style={[
                  styles.introAppIcon,
                  {
                    width: splashAppIconSize,
                    height: splashAppIconSize,
                    borderRadius: Math.round(splashAppIconSize * 0.176),
                  },
                ]}
                resizeMode="cover"
                onLoadEnd={() => {
                  splashIconLoadedRef.current = true;
                  tryHideNativeSplash();
                }}
              />
              <Animated.Text style={[styles.introFelizHoje, { transform: [{ scale: introFelizScale }] }]}>
                Feliz hoje!
              </Animated.Text>
            </View>
          </View>
        </Animated.View>
      ) : null}
      <View
        style={[styles.container, introVisible && styles.containerUnderSplash]}
        onStartShouldSetResponderCapture={() => {
          markInteraction();
          return false;
        }}
        onMoveShouldSetResponderCapture={() => {
          markInteraction();
          return false;
        }}
      >
        <ImageBackground
          source={cocoaPattern}
          style={styles.backgroundImage}
          resizeMode="repeat"
          imageStyle={styles.backgroundImageStyle}
        />
        <View style={styles.textureOverlay} />
        <View style={styles.embossLayer} pointerEvents="none">
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIcon, styles.embossOne]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIcon, styles.embossTwo]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIcon, styles.embossThree]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIcon, styles.embossFour]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIcon, styles.embossFive]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIconLarge, styles.embossPodOne]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIconLarge, styles.embossPodTwo]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIconLarge, styles.embossPodThree]}
            resizeMode="contain"
          />
          <Image
            source={cocoaPattern}
            style={[styles.cocoaIconLarge, styles.embossPodFour]}
            resizeMode="contain"
          />
        </View>

        {activeTab === 'perfil' ? (
          <ScrollView
            style={styles.profileScroll}
            contentContainerStyle={[
              styles.profileScrollContent,
              isLoggedIn &&
                loggedInAsReturning &&
                !welcomeReturnModalVisible &&
                styles.profileScrollContentDashboard,
              {
                paddingBottom:
                  (showRegisterForm ? 88 : 128) + Math.max(insets.bottom, 8),
              },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            refreshControl={
              <RefreshControl refreshing={isRefreshing} onRefresh={() => void handlePullRefresh()} />
            }
          >
            {!(isLoggedIn && loggedInAsReturning) ? (
              <>
                <Text style={styles.profileTitle}>
                  {showRegisterForm ? 'Crie sua conta' : 'Acesse sua conta'}
                </Text>
                <Text style={styles.profileSubtitle}>
                  {showRegisterForm
                    ? 'Informe e-mail, senha e seus dados para se cadastrar.'
                    : 'Entre para continuar no parque.'}
                </Text>
              </>
            ) : null}

            {isLoggedIn ? (
              loggedInAsReturning && welcomeReturnModalVisible ? (
                <View style={styles.profileAwaitingModalFill} />
              ) : loggedInAsReturning ? (
                <View
                  style={[
                    styles.profileDashboard,
                    {
                      width: screenWidth,
                      marginLeft: -(22 + insets.left),
                      marginRight: -(22 + insets.right),
                      marginTop: -(22 + insets.top) + 72,
                    },
                  ]}
                >
                  <View style={styles.profilePageAvatarBlock}>
                    <View style={styles.profilePageAvatarCircle}>
                      <TouchableOpacity
                        style={styles.profilePageAvatarImageMask}
                        onPress={() => setPhotoPreviewVisible(true)}
                        activeOpacity={0.9}
                        accessibilityRole="button"
                        accessibilityLabel="Ampliar foto de perfil"
                      >
                        {profilePhotoUri ? (
                          <Image
                            source={{ uri: profilePhotoUri }}
                            style={styles.profileAvatarImage}
                            resizeMode="cover"
                          />
                        ) : (
                          <Image
                            source={cocoaPattern}
                            style={styles.profileAvatarImage}
                            resizeMode="cover"
                          />
                        )}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.profilePageAvatarEditBtn}
                        onPress={openProfilePhotoPicker}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel="Editar foto de perfil"
                      >
                        <Feather name="camera" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <View style={styles.profilePageMenuCard}>
                    {[
                      {
                        label: 'Informa\u00e7\u00f5es pessoais',
                        onPress: () => {
                          if (!profileEmail && email) setProfileEmail(email);
                          setProfileModalVisible(true);
                        },
                      },
                      {
                        label: 'Informa\u00e7\u00f5es de contato',
                        onPress: () => {
                          if (!profileTelefone && telefone) setProfileTelefone(telefone);
                          if (!profileEmail && email) setProfileEmail(email);
                          setContactModalVisible(true);
                        },
                      },
                      { label: 'Senha', onPress: () => setPasswordModalVisible(true) },
                      {
                        label: 'Endere\u00e7o',
                        onPress: () => {
                          void loadAddressInfo();
                          setAddressModalVisible(true);
                        },
                      },
                    ].map((item, i, arr) => (
                      <TouchableOpacity
                        key={item.label}
                        style={[
                          styles.profileMenuRow,
                          i === arr.length - 1 && styles.profileMenuRowBeforeDanger,
                        ]}
                        activeOpacity={0.7}
                        onPress={item.onPress}
                      >
                        <Text style={styles.profileMenuRowLabel}>{item.label}</Text>
                        <Feather name="chevron-right" size={22} color="#9a8a7f" />
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={styles.profileMenuRowDangerWrap}
                      activeOpacity={0.7}
                      onPress={() => setDeleteConfirmVisible(true)}
                    >
                      <Text style={styles.profileMenuRowDanger}>Excluir conta</Text>
                      <Feather name="chevron-right" size={22} color="#c45c4a" />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.profileSairBtn]}
                    onPress={() => {
                      signOut();
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Sair</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.loggedCard}>
                  <Text style={styles.loggedTitle}>
                    {`Seja bem-vindo${userNome ? `, ${userNome}` : ''}!`}
                  </Text>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => {
                      signOut();
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Sair</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : (
              <View style={styles.loginCard}>
                <TextInput
                  value={email}
                  onChangeText={(t) => {
                    setEmail(t);
                    if (showRegisterForm && registerErrors.email) {
                      setRegisterErrors((prev) => ({ ...prev, email: undefined }));
                    }
                  }}
                  placeholder="E-mail"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  placeholderTextColor="#9a8a7f"
                  style={[
                    styles.input,
                    showRegisterForm && registerErrors.email ? styles.inputError : null,
                  ]}
                  editable={!authBusy}
                />
                {showRegisterForm && registerErrors.email ? (
                  <Text style={styles.fieldErrorText}>{registerErrors.email}</Text>
                ) : null}
                <View
                  style={[
                    styles.passwordRow,
                    showRegisterForm && registerErrors.password ? styles.passwordRowError : null,
                  ]}
                >
                  <TextInput
                    value={password}
                    onChangeText={(t) => {
                      setPassword(t);
                      if (showRegisterForm && registerErrors.password) {
                        setRegisterErrors((prev) => ({ ...prev, password: undefined }));
                      }
                    }}
                    placeholder="Senha"
                    secureTextEntry={!passwordVisible}
                    placeholderTextColor="#9a8a7f"
                    style={styles.passwordInput}
                    editable={!authBusy}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    style={styles.eyeButton}
                    onPress={() => setPasswordVisible((v) => !v)}
                    accessibilityLabel={passwordVisible ? 'Ocultar senha' : 'Mostrar senha'}
                    accessibilityRole="button"
                    hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  >
                    <Feather
                      name={passwordVisible ? 'eye-off' : 'eye'}
                      size={24}
                      color="#5f4333"
                    />
                  </TouchableOpacity>
                </View>
                {showRegisterForm && registerErrors.password ? (
                  <Text style={styles.fieldErrorText}>{registerErrors.password}</Text>
                ) : null}
                <Text style={styles.authHint}>
                  {'Senha de 8+ caracteres: Mai\u00fascula, min\u00fascula, n\u00famero e especial.'}
                </Text>

                {!showRegisterForm ? (
                  <TouchableOpacity
                    style={[styles.primaryButton, authBusy && styles.primaryButtonDisabled]}
                    onPress={handleEntrar}
                    disabled={authBusy}
                  >
                    {authBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Entrar</Text>
                    )}
                  </TouchableOpacity>
                ) : null}

                {showRegisterForm && (
                  <View style={[styles.registerBlock, styles.registerBlockCadastroFluxo]}>
                    <TextInput
                      value={nomeCompleto}
                      onChangeText={(t) => {
                        setNomeCompleto(t);
                        if (registerErrors.nomeCompleto) {
                          setRegisterErrors((prev) => ({ ...prev, nomeCompleto: undefined }));
                        }
                      }}
                      placeholder="Como você quer ser chamado (ex.: Jhow, Ju, Bete)"
                      placeholderTextColor="#9a8a7f"
                      style={[styles.input, registerErrors.nomeCompleto ? styles.inputError : null]}
                      editable={!authBusy}
                    />
                    {registerErrors.nomeCompleto ? (
                      <Text style={styles.fieldErrorText}>{registerErrors.nomeCompleto}</Text>
                    ) : null}
                    <TextInput
                      value={dataNascimento}
                      onChangeText={(t) => {
                        setDataNascimento(formatDataNascimentoDigits(t));
                        if (registerErrors.dataNascimento) {
                          setRegisterErrors((prev) => ({ ...prev, dataNascimento: undefined }));
                        }
                      }}
                      placeholder="Data de nascimento (DD/MM/AAAA)"
                      placeholderTextColor="#9a8a7f"
                      keyboardType="number-pad"
                      maxLength={10}
                      style={[styles.input, registerErrors.dataNascimento ? styles.inputError : null]}
                      editable={!authBusy}
                    />
                    {registerErrors.dataNascimento ? (
                      <Text style={styles.fieldErrorText}>{registerErrors.dataNascimento}</Text>
                    ) : null}
                    <TextInput
                      value={telefone}
                      onChangeText={setTelefone}
                      placeholder="Telefone (opcional)"
                      keyboardType="phone-pad"
                      placeholderTextColor="#9a8a7f"
                      style={styles.input}
                      editable={!authBusy}
                    />
                    <TextInput
                      value={cpf}
                      onChangeText={(t) => {
                        setCpf(formatCpfDigits(t));
                        if (registerErrors.cpf) {
                          setRegisterErrors((prev) => ({ ...prev, cpf: undefined }));
                        }
                      }}
                      placeholder="CPF (opcional)"
                      placeholderTextColor="#9a8a7f"
                      keyboardType="number-pad"
                      maxLength={14}
                      style={[styles.input, registerErrors.cpf ? styles.inputError : null]}
                      editable={!authBusy}
                      autoCorrect={false}
                    />
                    {registerErrors.cpf ? (
                      <Text style={styles.fieldErrorText}>{registerErrors.cpf}</Text>
                    ) : null}
                    <TouchableOpacity
                      style={[styles.primaryButton, authBusy && styles.primaryButtonDisabled]}
                      onPress={() => void handleCadastro()}
                      disabled={authBusy}
                    >
                      {authBusy ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.primaryButtonText}>Cadastrar</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.textButton}
                      onPress={() => {
                        setShowRegisterForm(false);
                        setRegisterErrors({});
                      }}
                      disabled={authBusy}
                    >
                      <Text style={styles.textButtonLabel}>Cancelar cadastro</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {!showRegisterForm ? (
                  <>
                    <TouchableOpacity style={styles.textButton} disabled={authBusy}>
                      <Text style={styles.textButtonLabel}>Esqueci minha senha</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.textButton}
                      disabled={authBusy}
                      onPress={() => {
                        setShowRegisterForm(true);
                        setRegisterErrors({});
                      }}
                    >
                      <Text style={styles.textButtonLabel}>Criar conta nova</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.googleButton, authBusy && styles.primaryButtonDisabled]}
                      onPress={() => void handleGooglePress()}
                      disabled={authBusy}
                    >
                      <Ionicons name="logo-google" size={18} color="#5f4333" />
                      <Text style={styles.googleButtonText}>Entrar com Google</Text>
                    </TouchableOpacity>
                  </>
                ) : null}
              </View>
            )}
          </ScrollView>
        ) : activeTab === 'mapa' ? (
            <View
              style={[
                styles.mapTabOuter,
                {
                  width: screenWidth,
                  marginLeft: -(22 + insets.left),
                  marginRight: -(22 + insets.right),
                  marginTop: -(22 + insets.top),
                },
              ]}
            >
              <ImageBackground
                source={cocoaPattern}
                style={styles.backgroundImage}
                resizeMode="repeat"
                imageStyle={styles.backgroundImageStyle}
              />
              <View style={styles.textureOverlay} />
              <View
                style={[
                  styles.mapTopChocolateBar,
                  {
                    paddingTop: insets.top + 10,
                    paddingBottom: 16,
                  },
                ]}
              >
                <Text style={styles.mapTopChocolateTitle} numberOfLines={1} ellipsizeMode="tail">
                  Mapa do parque
                </Text>
                <TouchableOpacity
                  style={styles.mapLegendButton}
                  activeOpacity={0.85}
                  onPress={() => {
                    setMapLegendOpenCategory(null);
                    setMapLegendVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Legenda do mapa"
                >
                  <Feather name="book-open" size={22} color="#fff" />
                </TouchableOpacity>
              </View>
              <View
                style={[
                  styles.mapContainer,
                  {
                    paddingTop: 0,
                    paddingBottom: mapBottomReserve,
                  },
                ]}
              >
              <View style={styles.mapGestureFrame} {...mapPanResponder.panHandlers}>
                <Animated.View
                  style={[
                    styles.mapContentFrame,
                    {
                      width: mapBaseSize,
                      height: mapBaseSize,
                      transform: [
                        { translateX: mapTranslate.x },
                        { translateY: mapTranslate.y },
                        { scale: mapScale },
                      ],
                    },
                  ]}
                >
                  <Image source={mapaParque} resizeMode="cover" style={styles.mapContentImage} />

                  {(mapLocais.length ? mapLocais : MAP_LOCAIS_DEMO)
                    .filter((local) => mapLocalCodigoExibePinNoMapa(local.codigo))
                    .map((local) => {
                    const left = local.x * mapBaseSize;
                    const top = local.y * mapBaseSize;
                    const width = local.w * mapBaseSize;
                    const height = local.h * mapBaseSize;
                    const iconSrc = mapHotspotIconSource(local);
                    const cat = resolveMapHotspotCategoria(local);
                    const markSize = MAP_HOTSPOT_MARK_SIZE;
                    const markRadius = markSize / 2;
                    const insetScale = mapHotspotIconInsetScale(cat);
                    const pulseRingSize = markSize + 3;
                    const pulseRingRadius = pulseRingSize / 2;
                    const rotateY = mapCoinRotate.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '360deg'],
                    });
                    return (
                      <Pressable
                        key={local.codigo}
                        onPress={() => {
                          setSelectedMapLocal(local);
                          zoomToLocal(local);
                        }}
                        style={[
                          styles.mapHotspot,
                          {
                            left,
                            top,
                            width,
                            height,
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Local: ${local.nome}`}
                      >
                        <View style={styles.mapHotspotMarkWrap}>
                          <Animated.View
                            pointerEvents="none"
                            style={[
                              styles.mapHotspotShineHalo,
                              {
                                width: pulseRingSize,
                                height: pulseRingSize,
                                borderRadius: pulseRingRadius,
                                backgroundColor: mapHotspotShineFillColor(cat),
                                opacity: mapHotspotShineOpacity,
                                transform: [
                                  { perspective: 1800 },
                                  { rotateY },
                                  { scale: mapHotspotShineScale },
                                ],
                              },
                            ]}
                          />
                          <Animated.View
                            pointerEvents="none"
                            style={[
                              styles.mapHotspotPulseRing,
                              {
                                width: pulseRingSize,
                                height: pulseRingSize,
                                borderRadius: pulseRingRadius,
                                borderColor: mapHotspotPulseRingColor(cat),
                                opacity: mapHotspotPulseOpacity,
                                transform: [{ perspective: 1800 }, { rotateY }],
                              },
                            ]}
                          />
                        <Animated.View
                            style={[
                              styles.mapHotspotGlow,
                              {
                                width: markSize,
                                height: markSize,
                                borderRadius: markRadius,
                              transform: [
                                { perspective: 1800 },
                                { rotateY },
                              ],
                              },
                            ]}
                          >
                          <View style={styles.mapHotspotCoinGloss} />
                          <View style={styles.mapHotspotCoinTint} />
                            <Image
                              source={iconSrc}
                              resizeMode="cover"
                              style={[
                                styles.mapHotspotIcon,
                                {
                                  borderRadius: markRadius,
                                  transform: [{ scale: insetScale }],
                                },
                              ]}
                            />
                        </Animated.View>
                        </View>
                      </Pressable>
                    );
                  })}
                </Animated.View>
              </View>

              {selectedMapLocal ? (
              <View
                style={[
                  styles.mapInfoSheet,
                  {
                    bottom: insets.bottom + 88,
                  },
                ]}
              >
                <View style={styles.mapInfoHeaderRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mapInfoTitle}>{selectedMapLocal.nome}</Text>
                    {selectedMapLocal.tempoFilaMin != null ? (
                      <Text style={styles.mapInfoFila}>
                        Fila: {selectedMapLocal.tempoFilaMin} min
                      </Text>
                    ) : null}
                    <Text style={styles.mapInfoDetailLine}>
                      Categoria: {mapCategoriaDisplayLabel(selectedMapLocal)}
                    </Text>
                    {selectedMapLocal.classificacao ? (
                      <Text style={styles.mapInfoDetailLine}>
                        {'Classifica\u00e7\u00e3o: '} {selectedMapLocal.classificacao}
                      </Text>
                    ) : null}
                    {selectedMapLocal.alturaMinCm != null ? (
                      <Text style={styles.mapInfoDetailLine}>
                        {'Altura m\u00ednima: '} {selectedMapLocal.alturaMinCm} cm
                      </Text>
                    ) : null}
                    <Text style={styles.mapInfoDetailLine}>
                      Status: {mapStatusDisplayLabel(selectedMapLocal)}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={styles.mapInfoClose}
                    onPress={() => {
                      setSelectedMapLocal(null);
                      resetMapView();
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Fechar"
                  >
                    <Text style={styles.mapInfoCloseText}>X</Text>
                  </TouchableOpacity>
                </View>

                {mapInfoImageUri ? (
                  <Image
                    key={`${selectedMapLocal?.codigo || 'local'}:${mapInfoImageAttempt}`}
                    source={{
                      uri: mapInfoImageUri,
                    }}
                    style={styles.mapInfoAttractionImage}
                    resizeMode="cover"
                    onError={() => {
                      setMapInfoImageAttempt((prev) => prev + 1);
                    }}
                  />
                ) : null}
              </View>
              ) : null}
              </View>
            </View>
        ) : activeTab === 'ingressos' ? (
          <ImageBackground
            source={splashStillImage}
            style={[
              styles.ingressosFullBleed,
              {
                width: screenWidth,
                marginLeft: -(22 + insets.left),
                marginRight: -(22 + insets.right),
                marginTop: -(22 + insets.top),
                // Deixa aparecer o fundo padrão sob a barra inferior (igual às outras telas).
                marginBottom: homeBottomReserve,
              },
            ]}
            resizeMode="cover"
            imageStyle={styles.ingressosFullBleedImage}
          >
            <View style={styles.ingressosFullBleedDim} pointerEvents="none" />
            <View
              style={[styles.ingressosContent, { paddingTop: insets.top + 16 }]}
              pointerEvents="box-none"
            >
              <View style={styles.ingressosPopup} accessibilityRole="alert">
                <View style={styles.ingressosPopupRow}>
                  <MaterialCommunityIcons name="hammer-wrench" size={44} color="#7b4228" />
                  <Text style={styles.ingressosPopupTitle} accessibilityRole="text">
                    {'Desculpe, estamos em constru\u00e7\u00e3o'}
                  </Text>
                </View>
              </View>
            </View>
          </ImageBackground>
        ) : (
          <ScrollView
            style={[styles.homeRefreshScroll, { marginBottom: homeBottomReserve }]}
            contentContainerStyle={[
              styles.homeRefreshScrollContent,
              { paddingBottom: homeBottomReserve },
            ]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={isRefreshing} onRefresh={() => void handlePullRefresh()} />
            }
          >
            <View style={[styles.header, { paddingTop: Math.max(insets.top - 6, 0) }]}>
              {isLoggedIn ? (
                <>
                  <View style={styles.homeProfileAvatarBlock}>
                    <View style={styles.profileAvatarCircle}>
                      <TouchableOpacity
                        style={styles.profileAvatarImageMask}
                        onPress={() => setPhotoPreviewVisible(true)}
                        activeOpacity={0.9}
                        accessibilityRole="button"
                        accessibilityLabel="Ampliar foto de perfil"
                      >
                        <Image
                          source={profilePhotoUri ? { uri: profilePhotoUri } : cocoaPattern}
                          style={styles.profileAvatarImage}
                          resizeMode="cover"
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <Text style={styles.subtitle}>
                    {'Bem-vindo ao mundo onde o chocolate e a divers\u00e3o se conectam.'}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.brandTitle}>Cacau Show</Text>
                  <Text style={styles.subtitle}>
                    {'Bem-vindo ao mundo onde o chocolate e a divers\u00e3o se conectam.'}
                  </Text>
                </>
              )}
            </View>

            <View style={styles.storeCard}>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(event) => handleSlideChange(event.nativeEvent.contentOffset.x)}
              >
                {carouselItems.map((item) => (
                  <TouchableOpacity
                    key={item.title}
                    style={[styles.slideWrapper, { width: cardWidth }]}
                    activeOpacity={0.9}
                    onPress={() => {
                      if (item.openMapCategory) {
                        openMapFromHome(item.openMapCategory);
                      }
                    }}
                  >
                    <ImageBackground
                      source={item.image}
                      style={styles.storeImage}
                      imageStyle={styles.storeImageRadius}
                    >
                      <Text style={styles.storeText}>{item.title}</Text>
                    </ImageBackground>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={styles.indicatorRow}>
              {carouselItems.map((item, index) => (
                <View
                  key={item.title}
                  style={[styles.indicatorDot, activeSlide === index && styles.indicatorDotActive]}
                />
              ))}
            </View>

            <Text style={styles.homeSectionTitle}>{'Hot\u00e9is'}</Text>

            <View style={[styles.storeCard, styles.homeSectionCard]}>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(event) =>
                  handleHotelSlideChange(event.nativeEvent.contentOffset.x)
                }
              >
                {hotelCarouselItems.map((item) => (
                  <View key={item.title} style={[styles.slideWrapper, { width: cardWidth }]}>
                    <ImageBackground
                      source={item.image}
                      style={[styles.storeImage, styles.hotelCarouselImage]}
                      imageStyle={styles.storeImageRadius}
                    >
                      <Text style={[styles.storeText, styles.hotelCarouselTitle]}>{item.title}</Text>
                    </ImageBackground>
                  </View>
                ))}
              </ScrollView>
            </View>

            <View style={styles.indicatorRow}>
              {hotelCarouselItems.map((item, index) => (
                <View
                  key={item.title}
                  style={[
                    styles.indicatorDot,
                    activeHotelSlide === index && styles.indicatorDotActive,
                  ]}
                />
              ))}
            </View>

            <Text style={styles.homeSectionTitle}>{'Visite a f\u00e1brica de chocolate'}</Text>

            <View style={styles.factoryCardWrap}>
              <ImageBackground
                source={factoryHighlightImage}
                style={styles.factoryCard}
                imageStyle={styles.storeImageRadius}
                onError={() => setFactoryImageAttempt((prev) => prev + 1)}
              >
                <View style={styles.factoryCardDim} pointerEvents="none" />
                <Text style={styles.factoryCardHint}>{'F\u00e1brica de chocolate'}</Text>
              </ImageBackground>
            </View>
          </ScrollView>
        )}

        {showBottomNav ? (
          <View
            style={[
              styles.bottomNav,
              { paddingBottom: Math.max(insets.bottom, 10) },
            ]}
          >
            <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('home')}>
              <View style={[styles.iconBubble, activeTab === 'home' && styles.activeIconBubble]}>
                <Feather name="home" size={21} color={activeTab === 'home' ? '#fff' : '#6a4b39'} />
              </View>
              <Text style={activeTab === 'home' ? styles.activeNavLabel : styles.navLabel}>Home</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('ingressos')}>
              <View style={[styles.iconBubble, activeTab === 'ingressos' && styles.activeIconBubble]}>
                <MaterialCommunityIcons
                  name="ticket-confirmation-outline"
                  size={21}
                  color={activeTab === 'ingressos' ? '#fff' : '#6a4b39'}
                />
              </View>
              <Text style={activeTab === 'ingressos' ? styles.activeNavLabel : styles.navLabel}>Ingressos</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('mapa')}>
              <View style={[styles.iconBubble, activeTab === 'mapa' && styles.activeIconBubble]}>
                <Feather name="map" size={21} color={activeTab === 'mapa' ? '#fff' : '#6a4b39'} />
              </View>
              <Text style={activeTab === 'mapa' ? styles.activeNavLabel : styles.navLabel}>Mapa</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('perfil')}>
              <View style={[styles.iconBubble, activeTab === 'perfil' && styles.activeIconBubble]}>
                <Ionicons
                  name="person-outline"
                  size={21}
                  color={activeTab === 'perfil' ? '#fff' : '#6a4b39'}
                />
              </View>
              <Text style={activeTab === 'perfil' ? styles.activeNavLabel : styles.navLabel}>Perfil</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {activeTab === 'perfil' &&
        isLoggedIn &&
        authLoginMethod === 'email' &&
        isClienteCadastroFuncionario ? (
          <TouchableOpacity
            style={[
              styles.profileConfigFab,
              {
                width: PROFILE_CONFIG_FAB_SIZE,
                height: PROFILE_CONFIG_FAB_SIZE,
                borderRadius: PROFILE_CONFIG_FAB_SIZE / 2,
                bottom: profileConfigFabBottom,
                right: profileConfigFabRight,
              },
            ]}
            activeOpacity={0.88}
            onPress={() => setFuncionarioConfigVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir configurações"
          >
            <Feather name="settings" size={18} color="#5f4333" />
          </TouchableOpacity>
        ) : null}
      </View>
      <Modal
        visible={profileModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setProfileModalVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setProfileModalVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar informa\u00e7\u00f5es pessoais"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>{'Informa\u00e7\u00f5es pessoais'}</Text>
            <TextInput
              value={profileNome}
              onChangeText={setProfileNome}
              placeholder="Nome"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={profileSobrenome}
              onChangeText={setProfileSobrenome}
              placeholder="Sobrenome"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={profileApelido}
              onChangeText={setProfileApelido}
              placeholder="Apelido"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={profileEmail}
              onChangeText={setProfileEmail}
              placeholder="E-mail"
              placeholderTextColor="#9a8a7f"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              editable={!profileSaving}
            />
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={styles.profileEditCancelBtn}
                onPress={() => setProfileModalVisible(false)}
                disabled={profileSaving}
              >
                <Text style={styles.profileEditCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, styles.profileEditSaveBtn, profileSaving && styles.primaryButtonDisabled]}
                onPress={() => void savePersonalInfo()}
                disabled={profileSaving}
              >
                {profileSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Salvar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={photoPreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPhotoPreviewVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={65} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setPhotoPreviewVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar visualiza\u00e7\u00e3o da foto"
          />
          <View style={styles.photoPreviewCard}>
            <Image
              source={profilePhotoUri ? { uri: profilePhotoUri } : cocoaPattern}
              style={styles.photoPreviewImage}
              resizeMode="cover"
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={photoPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPhotoPickerVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setPhotoPickerVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar sele\u00e7\u00e3o de foto"
          />
          <View style={styles.photoPickerCard}>
            <Text style={styles.photoPickerTitle}>Editar foto</Text>
            <TouchableOpacity
              style={styles.photoPickerOption}
              onPress={() => void pickProfilePhotoFromCamera()}
              activeOpacity={0.82}
            >
              <Text style={styles.photoPickerOptionText}>Tirar foto</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.photoPickerOption}
              onPress={() => void pickProfilePhotoFromGallery()}
              activeOpacity={0.82}
            >
              <Text style={styles.photoPickerOptionText}>Galeria</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.photoPickerOption}
              onPress={() => void pickProfilePhotoFromFiles()}
              activeOpacity={0.82}
            >
              <Text style={styles.photoPickerOptionText}>Arquivos / Google Drive</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={contactModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setContactModalVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setContactModalVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar informa\u00e7\u00f5es de contato"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>{'Informa\u00e7\u00f5es de contato'}</Text>
            <TextInput
              value={profileTelefone}
              onChangeText={setProfileTelefone}
              placeholder={'N\u00famero de telefone'}
              placeholderTextColor="#9a8a7f"
              keyboardType="phone-pad"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={profileEmail}
              onChangeText={setProfileEmail}
              placeholder="E-mail"
              placeholderTextColor="#9a8a7f"
              keyboardType="email-address"
              autoCapitalize="none"
              style={styles.input}
              editable={!profileSaving}
            />
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={styles.profileEditCancelBtn}
                onPress={() => setContactModalVisible(false)}
                disabled={profileSaving}
              >
                <Text style={styles.profileEditCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, styles.profileEditSaveBtn, profileSaving && styles.primaryButtonDisabled]}
                onPress={() => void saveContactInfo()}
                disabled={profileSaving}
              >
                {profileSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Salvar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={passwordModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPasswordModalVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setPasswordModalVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar tela de senha"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Senha</Text>
            <View style={styles.passwordRow}>
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Senha atual"
                secureTextEntry={!currentPasswordVisible}
                placeholderTextColor="#9a8a7f"
                style={styles.passwordInput}
                editable={!profileSaving}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setCurrentPasswordVisible((v) => !v)}
                accessibilityLabel={currentPasswordVisible ? 'Ocultar senha atual' : 'Mostrar senha atual'}
                accessibilityRole="button"
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                disabled={profileSaving}
              >
                <Feather
                  name={currentPasswordVisible ? 'eye-off' : 'eye'}
                  size={24}
                  color="#5f4333"
                />
              </TouchableOpacity>
            </View>
            <View style={styles.passwordRow}>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="Nova senha"
                secureTextEntry={!newPasswordVisible}
                placeholderTextColor="#9a8a7f"
                style={styles.passwordInput}
                editable={!profileSaving}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setNewPasswordVisible((v) => !v)}
                accessibilityLabel={newPasswordVisible ? 'Ocultar nova senha' : 'Mostrar nova senha'}
                accessibilityRole="button"
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                disabled={profileSaving}
              >
                <Feather
                  name={newPasswordVisible ? 'eye-off' : 'eye'}
                  size={24}
                  color="#5f4333"
                />
              </TouchableOpacity>
            </View>
            <Text style={styles.authHint}>
              {'Senha de 8+ caracteres: Mai\u00fascula, min\u00fascula, n\u00famero e especial.'}
            </Text>
            <TouchableOpacity
              style={[styles.profileChocolateButton, profileSaving && styles.primaryButtonDisabled]}
              onPress={() => void savePasswordInfo()}
              disabled={profileSaving}
              activeOpacity={0.85}
            >
              <Text style={styles.profileChocolateButtonText}>Atualizar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={addressModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddressModalVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setAddressModalVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar tela de endere\u00e7o"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>{'Endere\u00e7o'}</Text>
            <TextInput
              value={addressRua}
              onChangeText={setAddressRua}
              placeholder="Rua"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={addressBairro}
              onChangeText={setAddressBairro}
              placeholder="Bairro"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={addressPais}
              onChangeText={setAddressPais}
              placeholder={'Pa\u00eds'}
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={addressCep}
              onChangeText={setAddressCep}
              placeholder="CEP"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!profileSaving}
            />
            <TextInput
              value={addressNumero}
              onChangeText={setAddressNumero}
              placeholder={'N\u00famero'}
              placeholderTextColor="#9a8a7f"
              keyboardType="number-pad"
              style={styles.input}
              editable={!profileSaving}
            />
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={[styles.profileActionBtn, styles.profileActionBtnSecondary]}
                onPress={() => setAddressModalVisible(false)}
                disabled={profileSaving}
              >
                <Text style={styles.profileActionBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.profileActionBtn, styles.profileActionBtnPrimary, profileSaving && styles.primaryButtonDisabled]}
                onPress={() => void saveAddressInfo()}
                disabled={profileSaving}
              >
                {profileSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.profileActionBtnPrimaryText}>Salvar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={deleteConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteConfirmVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setDeleteConfirmVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar confirma\u00e7\u00e3o de exclus\u00e3o"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Excluir conta</Text>
            <Text style={styles.welcomeModalMessage}>
              Tem certeza que deseja excluir sua conta? Esta a\u00e7\u00e3o \u00e9 permanente.
            </Text>
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={[styles.profileActionBtn, styles.profileActionBtnSecondary]}
                onPress={() => setDeleteConfirmVisible(false)}
                disabled={deleteBusy}
              >
                <Text style={styles.profileActionBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.profileActionBtn, styles.profileActionBtnPrimary, deleteBusy && styles.primaryButtonDisabled]}
                onPress={() => void handleDeleteAccount()}
                disabled={deleteBusy}
              >
                {deleteBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.profileActionBtnPrimaryText}>Confirmar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={deleteDoneVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteDoneVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <View style={styles.welcomeModalCard}>
            <Text style={styles.welcomeModalTitle}>{'Conta excluída'}</Text>
            <Text style={styles.welcomeModalMessage}>
              {'Ficamos tristes com essa decisão, mas nos encontraremos em breve!'}
            </Text>
            <TouchableOpacity
              style={styles.welcomeModalOk}
              onPress={() => setDeleteDoneVisible(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.welcomeModalOkText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={welcomeReturnModalVisible && isLoggedIn && loggedInAsReturning}
        transparent
        animationType="fade"
        onRequestClose={() => setWelcomeReturnModalVisible(false)}
      >
        <View style={styles.welcomeModalBackdrop}>
          <View style={styles.welcomeModalCard}>


            <Text style={styles.welcomeModalFelizBig}>Feliz hoje!</Text>
            <Text style={styles.welcomeModalMessage}>
              {userNome.trim()
                ? `Seja bem-vindo(a) novamente, ${userNome.trim()}!`
                : 'Seja bem-vindo(a) novamente!'}
            </Text>
            <TouchableOpacity
              style={styles.welcomeModalOk}
              onPress={() => setWelcomeReturnModalVisible(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.welcomeModalOkText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={mapLegendVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setMapLegendVisible(false);
          setMapLegendOpenCategory(null);
        }}
      >
        <View style={styles.mapLegendBackdrop}>
          <Pressable
            style={styles.mapLegendBackdropFill}
            onPress={() => {
              setMapLegendVisible(false);
              setMapLegendOpenCategory(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Fechar legenda"
          />
          <View style={[styles.mapLegendCard, { maxHeight: screenHeight * 0.84 }]}>
            <View style={styles.mapLegendCardHeader}>
              <Text style={styles.mapLegendCardTitle}>Legenda do mapa</Text>
              <TouchableOpacity
                onPress={() => {
                  setMapLegendVisible(false);
                  setMapLegendOpenCategory(null);
                }}
                style={styles.mapLegendCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Fechar"
              >
                <Text style={styles.mapLegendCloseBtnText}>X</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.mapLegendHint}>
              {
                ' Abaixo estão todos os locais do parque, use a rolagem na lista.'
              }
            </Text>
            <ScrollView
              style={[styles.mapLegendScroll, { maxHeight: screenHeight * 0.84 - 132 }]}
              contentContainerStyle={styles.mapLegendScrollContent}
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {MAP_LEGEND_ROWS.map((row) => {
                const locaisAtuais = (mapLocais.length ? mapLocais : MAP_LOCAIS_DEMO).filter(
                  (l) => mapLocalExibirNaLegendaDoMapa(l.codigo)
                );
                const itens = [...locaisDaCategoria(locaisAtuais, row.key)].sort((a, b) =>
                  a.nome.localeCompare(b.nome, 'pt-BR')
                );
                const aberto = mapLegendOpenCategory === row.key;
                return (
                  <View key={row.key} style={styles.mapLegendSection}>
                    <TouchableOpacity
                      style={styles.mapLegendRow}
                      activeOpacity={0.82}
                      onPress={() =>
                        setMapLegendOpenCategory(aberto ? null : row.key)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`${row.title}. ${itens.length} locais.`}
                    >
                      <View style={styles.mapLegendIconWrap}>
                        <View
                          style={[
                            styles.mapHotspotGlow,
                            {
                              width: MAP_HOTSPOT_MARK_SIZE,
                              height: MAP_HOTSPOT_MARK_SIZE,
                              borderRadius: MAP_HOTSPOT_MARK_SIZE / 2,
                            },
                          ]}
                        >
                          <Image
                            source={BUNDLED_MAP_ICONS[row.key]}
                            resizeMode="cover"
                            style={[
                              styles.mapHotspotIcon,
                              {
                                borderRadius: MAP_HOTSPOT_MARK_SIZE / 2,
                                transform: [
                                  { scale: mapHotspotIconInsetScale(row.key) },
                                ],
                              },
                            ]}
                          />
                        </View>
                      </View>
                      <View style={styles.mapLegendRowText}>
                        <Text style={styles.mapLegendRowTitle}>{row.title}</Text>
                        <Text style={styles.mapLegendRowSub}>{row.subtitle}</Text>
                      </View>
                      <Feather
                        name={aberto ? 'chevron-up' : 'chevron-down'}
                        size={22}
                        color="#7b4228"
                      />
                    </TouchableOpacity>
                    {aberto ? (
                      <View style={styles.mapLegendList}>
                        {itens.length === 0 ? (
                          <Text style={styles.mapLegendListEmpty}>Nenhum local nesta categoria.</Text>
                        ) : (
                          itens.map((local) => {
                            const legendaClassAlt = mapLegendItemClassificacaoAlturaLine(local);
                            return (
                              <TouchableOpacity
                                key={local.codigo}
                                style={styles.mapLegendListItem}
                                activeOpacity={0.85}
                                onPress={() => {
                                  setMapLegendVisible(false);
                                  setMapLegendOpenCategory(null);
                                  setSelectedMapLocal(local);
                                  if (mapLocalCodigoExibePinNoMapa(local.codigo)) {
                                    zoomToLocal(local);
                                  } else {
                                    resetMapView();
                                  }
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={
                                  legendaClassAlt ? `${local.nome}. ${legendaClassAlt}` : local.nome
                                }
                              >
                                <View style={styles.mapLegendListItemRow}>
                                  <Text style={styles.mapLegendListItemText} numberOfLines={2}>
                                    {local.nome}
                                  </Text>
                                  {isLocalClosed(local) ? (
                                    <Feather
                                      name="x-circle"
                                      size={14}
                                      color="#d92b2b"
                                      style={styles.mapLegendClosedIcon}
                                    />
                                  ) : row.key === 'diversao' && local.tempoFilaMin != null ? (
                                    <Text style={styles.mapLegendQueueMini}>
                                      {local.tempoFilaMin}m
                                    </Text>
                                  ) : null}
                                </View>
                                {legendaClassAlt ? (
                                  <Text style={styles.mapLegendListItemMeta} numberOfLines={2}>
                                    {legendaClassAlt}
                                  </Text>
                                ) : null}
                              </TouchableOpacity>
                            );
                          })
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={funcionarioConfigVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setFuncionarioConfigVisible(false)}
      >
        <View style={styles.funcionarioConfigModalRoot}>
          <ImageBackground
            source={cocoaPattern}
            style={styles.backgroundImage}
            resizeMode="repeat"
            imageStyle={styles.backgroundImageStyle}
          />
          <View style={styles.textureOverlay} pointerEvents="none" />
          <View style={styles.funcionarioConfigForeground}>
            <View
              style={[
                styles.funcionarioConfigTopBar,
                { paddingTop: Math.max(insets.top, 10) + 6 },
              ]}
            >
              <TouchableOpacity
                style={styles.funcionarioConfigCloseHit}
                onPress={() => setFuncionarioConfigVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Fechar configura\u00e7\u00f5es"
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Feather name="x" size={24} color="#5f4333" />
              </TouchableOpacity>
              <View style={styles.funcionarioConfigTitleWrap}>
                <Text style={styles.funcionarioConfigTitle}>Configurações do funcionário</Text>
              </View>
              <View style={styles.funcionarioConfigCloseHit} />
            </View>
            <ScrollView
              style={styles.funcionarioConfigScroll}
              contentContainerStyle={[
                styles.funcionarioConfigScrollContent,
                { paddingBottom: 20 },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={[styles.profileDashboard, { width: screenWidth, marginTop: 4 }]}>
                <View style={styles.profilePageAvatarBlock}>
                  <View style={styles.profilePageAvatarCircle}>
                    <TouchableOpacity
                      style={styles.profilePageAvatarImageMask}
                      onPress={() => setPhotoPreviewVisible(true)}
                      activeOpacity={0.9}
                      accessibilityRole="button"
                      accessibilityLabel="Ampliar foto de perfil"
                    >
                      {profilePhotoUri ? (
                        <Image
                          source={{ uri: profilePhotoUri }}
                          style={styles.profileAvatarImage}
                          resizeMode="cover"
                        />
                      ) : (
                        <Image
                          source={cocoaPattern}
                          style={styles.profileAvatarImage}
                          resizeMode="cover"
                        />
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.profilePageAvatarEditBtn}
                      onPress={openProfilePhotoPicker}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityLabel="Editar foto de perfil"
                    >
                      <Feather name="camera" size={14} color="#fff" />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.profilePageMenuCard}>
                  {(
                    [
                      {
                        label: 'Cadastro do funcionário',
                        hint: 'Libere com senha 123 para configurar perfil de funcionário.',
                        alwaysEnabled: true,
                        onPress: () => openFuncionarioSetupAuth(),
                      },
                      ...(!perfilFuncionarioGestaoLoading &&
                      perfilFuncionarioGestao?.podeGerirCatalogoCargos
                        ? [
                            {
                              label: 'Cadastro de cargos',
                              hint: 'Fun\u00e7\u00f5es e cargos da empresa. Acrescente novos quando precisar.',
                              onPress: () => setCadastroCargosVisible(true),
                            },
                          ]
                        : []),
                      {
                        label: 'Equipe e presença',
                        hint:
                          'Colegas do mesmo setor e presença no calendário. Entrada e saída do dia: use Sim ou Não em Configurações.',
                        onPress: () => {
                          const m = formatAnoMes(new Date());
                          setEscalaMesYm(m);
                          setEscalaCalendarioMesYm(m);
                          setEscalaFiltroTrabalhando('todos');
                          void loadPerfilFuncionarioGestao();
                          setEscalaTrabalhoVisible(true);
                        },
                      },
                      {
                        label: 'Ocorr\u00eancias e solicita\u00e7\u00f5es',
                        hint: 'Abra chamados internos para sua \u00e1rea.',
                        onPress: () =>
                          Alert.alert(
                            'Ocorrências e solicitações',
                            'Abra chamados internos para sua área.\n\n(Recurso em construção.)'
                          ),
                      },
                      {
                        label: 'Documentos e treinamentos',
                        hint: 'Materiais e capacita\u00e7\u00f5es para funcion\u00e1rios.',
                        onPress: () =>
                          Alert.alert(
                            'Documentos e treinamentos',
                            'Materiais e capacitações para funcionários.\n\n(Recurso em construção.)'
                          ),
                      },
                      {
                        label: 'Comunicados internos',
                        hint: 'Avisos e comunica\u00e7\u00e3o da gest\u00e3o.',
                        onPress: () =>
                          Alert.alert(
                            'Comunicados internos',
                            'Avisos e comunicação da gestão.\n\n(Recurso em construção.)'
                          ),
                      },
                    ]
                  ).map((item, i, arr) => {
                    const alwaysEnabled = 'alwaysEnabled' in item && item.alwaysEnabled;
                    const disabled = !alwaysEnabled && !isFuncionarioAtivo;
                    return (
                    <TouchableOpacity
                      key={item.label}
                      style={[
                        styles.profileMenuRow,
                        disabled && styles.profileMenuRowDisabled,
                        i === arr.length - 1 && styles.profileMenuRowBeforeDanger,
                      ]}
                      activeOpacity={0.7}
                      onPress={item.onPress}
                      disabled={disabled}
                    >
                      <Text
                        style={[
                          styles.profileMenuRowLabel,
                          disabled && styles.profileMenuRowLabelDisabled,
                        ]}
                      >
                        {item.label}
                      </Text>
                      <Feather name="chevron-right" size={22} color="#9a8a7f" />
                    </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>
            {isLoggedIn && currentClienteId != null && isClienteCadastroFuncionario ? (
              <View
                style={[
                  styles.funcionarioConfigFooter,
                  { paddingBottom: 12 + Math.max(insets.bottom, 8) },
                ]}
              >
                <Text style={styles.funcionarioConfigEmServicoTitulo}>Está em serviço agora?</Text>
                <Text style={styles.funcionarioConfigEmServicoSub}>
                  Enquanto estiver no expediente, deixe em Sim; Quando sair ou encerrar o turno, toque em Não.
                </Text>
                <View style={styles.funcionarioConfigEmServicoRow}>
                  <TouchableOpacity
                    style={[
                      styles.funcionarioConfigEmServicoBtn,
                      styles.funcionarioConfigEmServicoBtnSim,
                      funcionarioEmServico === true
                        ? styles.funcionarioConfigEmServicoBtnSelSim
                        : styles.funcionarioConfigEmServicoBtnUnsel,
                    ]}
                    activeOpacity={0.85}
                    onPress={() => void persistFuncionarioEmServico(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Sim, estou em serviço no expediente"
                    accessibilityState={{ selected: funcionarioEmServico === true }}
                  >
                    <Text style={styles.funcionarioConfigEmServicoBtnText}>Sim</Text>
                    <Text style={styles.funcionarioConfigEmServicoBtnSub}>No trabalho</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.funcionarioConfigEmServicoBtn,
                      styles.funcionarioConfigEmServicoBtnNao,
                      funcionarioEmServico === false
                        ? styles.funcionarioConfigEmServicoBtnSelNao
                        : styles.funcionarioConfigEmServicoBtnUnsel,
                    ]}
                    activeOpacity={0.85}
                    onPress={() => void persistFuncionarioEmServico(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Não, já saí ou encerrei o expediente"
                    accessibilityState={{ selected: funcionarioEmServico === false }}
                  >
                    <Text style={styles.funcionarioConfigEmServicoBtnText}>Não</Text>
                    <Text style={styles.funcionarioConfigEmServicoBtnSub}>Estou fora</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={cadastroCargosVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCadastroCargosVisible(false)}
      >
        <SafeAreaView style={styles.escalaModalSafe} edges={['top', 'left', 'right']}>
          <View style={styles.escalaModalHeader}>
            <TouchableOpacity
              onPress={() => setCadastroCargosVisible(false)}
              style={styles.funcionarioConfigCloseHit}
              accessibilityRole="button"
              accessibilityLabel="Fechar cadastro de cargos"
            >
              <Feather name="arrow-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <View style={styles.funcionarioConfigTitleWrap}>
              <Text style={styles.funcionarioConfigTitle} numberOfLines={2}>
                Cadastro de cargos
              </Text>
            </View>
            <View style={styles.funcionarioConfigCloseHit} />
          </View>
          <ScrollView
            style={styles.cadastroCargosScroll}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: 24 + Math.max(insets.bottom, 8),
            }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.cadastroCargosLabel}>Nome do cargo</Text>
            <TextInput
              value={cadastroCargosNovoNome}
              onChangeText={(t) => {
                setCadastroCargosNovoNome(t);
                setCadastroCargosFieldErrors((e) => ({ ...e, nome: undefined }));
              }}
              placeholder="Ex.: Coordenador de projetos"
              placeholderTextColor="#9a8a7f"
              style={[
                styles.cadastroCargosInput,
                cadastroCargosFieldErrors.nome ? styles.cadastroCargosInputError : null,
              ]}
              maxLength={120}
              autoCapitalize="sentences"
            />
            {cadastroCargosFieldErrors.nome ? (
              <Text style={styles.cadastroCargosFieldErrText}>{cadastroCargosFieldErrors.nome}</Text>
            ) : null}
            <Text style={styles.cadastroCargosLabel}>Cargo superior imediato</Text>
            <TouchableOpacity
              style={[
                styles.cadastroCargosPickerBtn,
                cadastroCargosFieldErrors.subordinadoACargoId
                  ? styles.cadastroCargosInputError
                  : null,
                cadastroCargosLoading ? { opacity: 0.65 } : null,
              ]}
              onPress={() => {
                if (cadastroCargosLoading) return;
                setCadastroCargosSuperiorPickerOpen(true);
              }}
              disabled={cadastroCargosLoading}
              accessibilityRole="button"
              accessibilityLabel="Abrir lista do cargo superior imediato"
            >
              <Text
                style={[
                  styles.cadastroCargosPickerBtnText,
                  !cadastroCargosList.find((x) => x.id === cadastroCargosSubordinadoAId)?.nome
                    ? styles.cadastroCargosPickerBtnPlaceholder
                    : null,
                ]}
                numberOfLines={2}
              >
                {cadastroCargosList.find((x) => x.id === cadastroCargosSubordinadoAId)?.nome?.trim() ||
                  'Toque para escolher (ex.: Gerente, Líder)'}
              </Text>
              <Feather name="chevron-down" size={22} color="#5f4333" />
            </TouchableOpacity>
            {cadastroCargosFieldErrors.subordinadoACargoId ? (
              <Text style={styles.cadastroCargosFieldErrText}>
                {cadastroCargosFieldErrors.subordinadoACargoId}
              </Text>
            ) : null}
            {!cadastroCargosLoading && cadastroCargosComOrdemParaSuperior.length === 0 ? (
              <Text style={styles.cadastroCargosFieldErrText}>
                N\u00e3o h\u00e1 cargos com ordem definida para refer\u00eancia. Aguarde o carregamento ou
                tente novamente.
              </Text>
            ) : null}
            <Text style={styles.cadastroCargosLabel}>Setor</Text>
            <TextInput
              value={cadastroCargosNovoSetor}
              onChangeText={(t) => {
                setCadastroCargosNovoSetor(t);
                setCadastroCargosFieldErrors((e) => ({ ...e, setor: undefined }));
              }}
              placeholder="Ex.: Produção, Administrativo"
              placeholderTextColor="#9a8a7f"
              style={[
                styles.cadastroCargosInput,
                cadastroCargosFieldErrors.setor ? styles.cadastroCargosInputError : null,
              ]}
              maxLength={80}
              autoCapitalize="sentences"
            />
            {cadastroCargosFieldErrors.setor ? (
              <Text style={styles.cadastroCargosFieldErrText}>{cadastroCargosFieldErrors.setor}</Text>
            ) : null}
            <Text style={styles.cadastroCargosLabel}>Nível (opcional)</Text>
            <TextInput
              value={cadastroCargosNovoNivel}
              onChangeText={(t) => {
                setCadastroCargosNovoNivel(t.slice(0, 20));
                setCadastroCargosFieldErrors((e) => ({ ...e, nivel: undefined }));
              }}
              placeholder="Ex.: Pleno, Sênior"
              placeholderTextColor="#9a8a7f"
              style={[
                styles.cadastroCargosInput,
                cadastroCargosFieldErrors.nivel ? styles.cadastroCargosInputError : null,
              ]}
              maxLength={20}
              autoCapitalize="sentences"
            />
            {cadastroCargosFieldErrors.nivel ? (
              <Text style={styles.cadastroCargosFieldErrText}>{cadastroCargosFieldErrors.nivel}</Text>
            ) : null}
            <Text style={styles.cadastroCargosLabel}>Descrição (opcional)</Text>
            <TextInput
              value={cadastroCargosNovoDesc}
              onChangeText={(t) => {
                setCadastroCargosNovoDesc(t);
                setCadastroCargosFieldErrors((e) => ({ ...e, descricao: undefined }));
              }}
              placeholder="Observações ou detalhes do cargo"
              placeholderTextColor="#9a8a7f"
              style={[
                styles.cadastroCargosInput,
                styles.cadastroCargosInputMultiline,
                cadastroCargosFieldErrors.descricao ? styles.cadastroCargosInputError : null,
              ]}
              maxLength={500}
              multiline
            />
            {cadastroCargosFieldErrors.descricao ? (
              <Text style={styles.cadastroCargosFieldErrText}>
                {cadastroCargosFieldErrors.descricao}
              </Text>
            ) : null}
            <TouchableOpacity
              style={[
                styles.cadastroCargosSalvarBtn,
                (cadastroCargosNovoNome.trim().length < 2 ||
                  cadastroCargosNovoSetor.trim().length < 1 ||
                  cadastroCargosSubordinadoAId == null ||
                  cadastroCargosSaving) &&
                  styles.cadastroCargosSalvarBtnDisabled,
              ]}
              disabled={
                cadastroCargosNovoNome.trim().length < 2 ||
                cadastroCargosNovoSetor.trim().length < 1 ||
                cadastroCargosSubordinadoAId == null ||
                cadastroCargosSaving
              }
              onPress={() => void (async () => {
                const nome = cadastroCargosNovoNome.trim();
                const setor = cadastroCargosNovoSetor.trim();
                const nivel = cadastroCargosNovoNivel.trim();
                if (currentClienteId == null) return;
                const nextErr: {
                  nome?: string;
                  setor?: string;
                  nivel?: string;
                  descricao?: string;
                  subordinadoACargoId?: string;
                } = {};
                if (nome.length < 2 || nome.length > 120) {
                  nextErr.nome = 'O nome deve ter entre 2 e 120 caracteres.';
                }
                if (setor.length < 1) {
                  nextErr.setor = 'O setoré obrigatório.';
                }
                if (nivel.length > 20) {
                  nextErr.nivel = 'O nível pode ter no máximo 20 caracteres.';
                }
                if (cadastroCargosSubordinadoAId == null) {
                  nextErr.subordinadoACargoId = 'Selecione o cargo superior imediato.';
                }
                if (Object.keys(nextErr).length > 0) {
                  setCadastroCargosFieldErrors(nextErr);
                  setCadastroCargosError(null);
                  return;
                }
                setCadastroCargosSaving(true);
                setCadastroCargosError(null);
                setCadastroCargosFieldErrors({});
                try {
                  const base = apiBaseUrl();
                  const res = await fetchWithTimeout(
                    `${base}/api/funcionarios/${currentClienteId}/cadastro-cargos`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        nome,
                        setor,
                        nivel: nivel.length > 0 ? nivel : '',
                        descricao: cadastroCargosNovoDesc.trim(),
                        subordinadoACargoId: cadastroCargosSubordinadoAId,
                      }),
                    }
                  );
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    const errMsg =
                      typeof data.error === 'string' ? data.error : `Erro ${res.status}`;
                    const field = typeof data.field === 'string' ? data.field : '';
                    if (
                      field === 'nome' ||
                      field === 'setor' ||
                      field === 'nivel' ||
                      field === 'subordinadoACargoId'
                    ) {
                      setCadastroCargosFieldErrors({ [field]: errMsg });
                      setCadastroCargosError(null);
                    } else {
                      setCadastroCargosError(errMsg);
                    }
                    return;
                  }
                  setCadastroCargosNovoNome('');
                  setCadastroCargosNovoSetor('');
                  setCadastroCargosNovoNivel('');
                  setCadastroCargosNovoDesc('');
                  setCadastroCargosSubordinadoAId(null);
                  setCadastroCargosFieldErrors({});
                  await loadCadastroCargosCatalogo();
                } catch {
                  setCadastroCargosError('N\u00e3o foi poss\u00edvel salvar o cargo.');
                } finally {
                  setCadastroCargosSaving(false);
                }
              })()}
              accessibilityRole="button"
              accessibilityLabel="Salvar cargo no cat\u00e1logo"
            >
              {cadastroCargosSaving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.cadastroCargosSalvarBtnText}>Salvar cargo</Text>
              )}
            </TouchableOpacity>
            {cadastroCargosError ? (
              <Text style={styles.escalaErrorText}>{cadastroCargosError}</Text>
            ) : null}
            <Text style={styles.cadastroCargosSecTitulo}>Catálogo de cargos</Text>
            {cadastroCargosLoading ? (
              <View style={styles.escalaListFooterLoading}>
                <ActivityIndicator color="#6a4b39" />
                <Text style={styles.escalaLoadingText}>Carregando</Text>
              </View>
            ) : (
              cadastroCargosList.map((c) => (
                <View key={c.id} style={styles.cadastroCargosRow}>
                  <View style={styles.cadastroCargosRowText}>
                    <Text style={styles.cadastroCargosRowNome}>{c.nome}</Text>
                    {(c.setor ?? '').trim().length > 0 ? (
                      <Text style={styles.cadastroCargosRowMeta}>Setor {c.setor}</Text>
                    ) : null}
                    {(c.nivel ?? '').trim().length > 0 ? (
                      <Text style={styles.cadastroCargosRowMeta}>Nível {c.nivel}</Text>
                    ) : null}
                    {(c.descricao ?? '').trim().length > 0 ? (
                      <Text style={styles.cadastroCargosRowDesc} numberOfLines={3}>
                        {c.descricao}
                      </Text>
                    ) : null}
                  </View>
                  {c.padraoSistema ? (
                    <View style={styles.cadastroCargosBadge}>
                      <Text style={styles.cadastroCargosBadgeText}>Sistema</Text>
                    </View>
                  ) : (
                    <View style={styles.cadastroCargosBadgeCadastro}>
                      <Text style={styles.cadastroCargosBadgeText}>Empresa</Text>
                    </View>
                  )}
                </View>
              ))
            )}
          </ScrollView>
          <Modal
            visible={cadastroCargosSuperiorPickerOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setCadastroCargosSuperiorPickerOpen(false)}
          >
            <View style={styles.cadastroCargosPickerModalRoot}>
              <Pressable
                style={styles.cadastroCargosPickerModalBackdrop}
                onPress={() => setCadastroCargosSuperiorPickerOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Fechar seleção do cargo superior"
              />
              <View style={styles.cadastroCargosPickerCard}>
                <Text style={styles.cadastroCargosPickerTitle}>Cargo superior imediato</Text>
                <ScrollView
                  style={styles.cadastroCargosPickerScroll}
                  keyboardShouldPersistTaps="handled"
                >
                  {cadastroCargosComOrdemParaSuperior.map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.cadastroCargosPickerRow}
                      onPress={() => {
                        setCadastroCargosSubordinadoAId(c.id);
                        setCadastroCargosFieldErrors((e) => ({
                          ...e,
                          subordinadoACargoId: undefined,
                        }));
                        setCadastroCargosSuperiorPickerOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={c.nome}
                    >
                      <Text style={styles.cadastroCargosPickerRowNome}>{c.nome}</Text>
                      <Text style={styles.cadastroCargosPickerRowOrd}>
                        Ordem: {c.ordemExibicao}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <TouchableOpacity
                  style={styles.cadastroCargosPickerFechar}
                  onPress={() => setCadastroCargosSuperiorPickerOpen(false)}
                >
                  <Text style={styles.cadastroCargosPickerFecharText}>Fechar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={escalaTrabalhoVisible}
        animationType="slide"
        onRequestClose={() => {
          closeEscalaCalendarioColaborador();
          setEscalaBuscaInput('');
          setEscalaBuscaQuery('');
          setEscalaTrabalhoVisible(false);
        }}
      >
        {/* Modal no Android fica fora do root; GH aqui + FlatList/Touchables do RNGH liberam o Swipeable. */}
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={styles.escalaModalSafe} edges={['top', 'left', 'right']}>
          <View style={styles.escalaModalHeader}>
            <TouchableOpacity
              onPress={() => {
                closeEscalaCalendarioColaborador();
                setEscalaBuscaInput('');
                setEscalaBuscaQuery('');
                setEscalaTrabalhoVisible(false);
              }}
              style={styles.funcionarioConfigCloseHit}
              accessibilityRole="button"
              accessibilityLabel="Fechar Equipe e presença"
            >
              <Feather name="arrow-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <View style={styles.funcionarioConfigTitleWrap}>
              <Text style={styles.funcionarioConfigTitle} numberOfLines={2}>
                Equipe e presença
              </Text>
              <Text style={styles.escalaEquipeHeaderSub} numberOfLines={2}>
                Equipe do seu setor. Toque no calendário para ver a presença no mês selecionado.
              </Text>
            </View>
            <View style={styles.funcionarioConfigCloseHit} />
          </View>
          <View style={styles.escalaMesNav}>
            <TouchableOpacity
              onPress={() => {
                const [yy, mm] = escalaMesYm.split('-').map((x) => Number(x));
                const next = formatAnoMes(new Date(yy, mm - 2, 1));
                setEscalaMesYm(next);
                setEscalaCalendarioMesYm(next);
              }}
              style={styles.escalaMesNavBtn}
              accessibilityRole="button"
              accessibilityLabel="Mês anterior"
            >
              <Feather name="chevron-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <Text style={styles.escalaMesNavLabel} numberOfLines={1}>
              {(() => {
                const [yy, mm] = escalaMesYm.split('-').map((x) => Number(x));
                try {
                  return new Intl.DateTimeFormat('pt-BR', {
                    month: 'long',
                    year: 'numeric',
                  }).format(new Date(yy, mm - 1, 1));
                } catch {
                  return escalaMesYm;
                }
              })()}
            </Text>
            <TouchableOpacity
              onPress={() => {
                const [yy, mm] = escalaMesYm.split('-').map((x) => Number(x));
                const next = formatAnoMes(new Date(yy, mm, 1));
                setEscalaMesYm(next);
                setEscalaCalendarioMesYm(next);
              }}
              style={styles.escalaMesNavBtn}
              accessibilityRole="button"
              accessibilityLabel="Próximo mês"
            >
              <Feather name="chevron-right" size={24} color="#5f4333" />
            </TouchableOpacity>
          </View>
          {mostrarFiltrosEscalaEquipe ? (
            <View style={styles.escalaFiltroRow}>
              {(
                [
                  { key: 'todos' as const, label: 'Todos' },
                  { key: 'sim' as const, label: 'Em serviço' },
                  { key: 'nao' as const, label: 'Fora de serviço' },
                ]
              ).map(({ key, label }) => (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.escalaFiltroChip,
                    escalaFiltroTrabalhando === key && styles.escalaFiltroChipOn,
                  ]}
                  onPress={() => setEscalaFiltroTrabalhando(key)}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.escalaFiltroChipText,
                      escalaFiltroTrabalhando === key && styles.escalaFiltroChipTextOn,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <View style={styles.escalaBuscaRow}>
            <Feather name="search" size={18} color="#7a6a5e" style={styles.escalaBuscaIcon} />
            <TextInput
              value={escalaBuscaInput}
              onChangeText={setEscalaBuscaInput}
              placeholder="Nome ou ID"
              placeholderTextColor="#9a8a7f"
              style={styles.escalaBuscaInput}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel="Buscar por nome ou ID do colaborador"
            />
            {escalaBuscaInput.length > 0 ? (
              <TouchableOpacity
                onPress={() => {
                  setEscalaBuscaInput('');
                  setEscalaBuscaQuery('');
                }}
                style={styles.escalaBuscaClear}
                accessibilityRole="button"
                accessibilityLabel="Limpar busca"
              >
                <Feather name="x" size={20} color="#7a6a5e" />
              </TouchableOpacity>
            ) : null}
          </View>
          {escalaEquipeLoading ? (
            <View style={styles.escalaLoadingWrap}>
              <ActivityIndicator size="large" color="#6a4b39" />
              <Text style={styles.escalaLoadingText}>Carregando a equipe…</Text>
            </View>
          ) : escalaEquipeError ? (
            <View style={styles.escalaLoadingWrap}>
              <Text style={styles.escalaErrorText}>{escalaEquipeError}</Text>
              <TouchableOpacity
                style={styles.escalaRetryBtn}
                onPress={() => void fetchEscalaPage(0, false)}
              >
                <Text style={styles.escalaRetryBtnText}>Tentar novamente</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <GHFlatList
              style={styles.escalaListaScroll}
              data={escalaEquipe}
              keyExtractor={(item) => String(item.id)}
              removeClippedSubviews={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingBottom: 20 + Math.max(insets.bottom, 8),
                paddingHorizontal: 12,
                flexGrow: 1,
              }}
              ListEmptyComponent={
                <Text style={styles.escalaEmptyText}>
                  {escalaBuscaQuery.length > 0
                    ? 'Nenhum colaborador encontrado para esta busca.'
                    : 'Não há colaboradores neste filtro.\n\nQuem está em cargo de base vê apenas o próprio nome; gestores veem a equipe do mesmo setor.'}
                </Text>
              }
              ListFooterComponent={
                escalaEquipeLoadingMore ? (
                  <View style={styles.escalaListFooterLoading}>
                    <ActivityIndicator color="#6a4b39" />
                  </View>
                ) : null
              }
              onEndReachedThreshold={0.25}
              onEndReached={() => {
                if (!escalaEquipeHasMore || escalaEquipeLoadingMore || escalaEquipeLoading) return;
                void fetchEscalaPage(escalaEquipe.length, true);
              }}
              renderItem={({ item: mem }) => {
                const setorTxt = (mem.setor || '').trim() || '—';
                const cargoTxt = (mem.cargo || '').trim() || '—';
                const emServico = mem.statusTrabalho === 1;
                const nomeSobrenome = [mem.nome, mem.sobrenome]
                  .map((s) => (typeof s === 'string' ? s.trim() : ''))
                  .filter(Boolean)
                  .join(' ')
                  .trim();
                const linhaNome =
                  nomeSobrenome.length > 0 ? nomeSobrenome : primeiroNomeEscala(mem.nome, mem.apelido);
                const desligadoNoMes = membroDesligadoNoMesVisualizado(mem.dataDesligamento, escalaMesYm);
                const jaDesligado = Boolean(mem.dataDesligamento);
                const podeSwipeDesligar =
                  currentClienteId != null &&
                  mem.id !== currentClienteId &&
                  !jaDesligado &&
                  cargoPodeDesligarColaboradorEscala(getCargoViewerParaGestaoPonto());
                const rowContent = (
                  <View
                    style={[
                      styles.escalaRow,
                      desligadoNoMes && styles.escalaRowDesligadoMes,
                      escalaDesligandoId === mem.id ? styles.escalaRowDesligandoOpacity : null,
                    ]}
                  >
                    <View style={styles.escalaRowTextBlock}>
                      <View style={styles.escalaRowNameLine}>
                        <Text
                          style={[
                            styles.escalaRowNomeCompleto,
                            desligadoNoMes && styles.escalaRowNomeRiscado,
                          ]}
                          numberOfLines={2}
                        >
                          {linhaNome}
                          <Text
                            style={[
                              styles.escalaRowIdBadge,
                              desligadoNoMes && styles.escalaRowNomeRiscado,
                            ]}
                          >
                            {' '}
                            #{mem.id}
                          </Text>
                        </Text>
                      </View>
                      <Text style={styles.escalaRowSetorCargo} numberOfLines={1}>
                        {setorTxt} · {cargoTxt}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.escalaStatusPill,
                        emServico ? styles.statusPillVerde : styles.statusPillVermelho,
                        styles.escalaRowPill,
                      ]}
                    >
                      <Text style={styles.escalaStatusPillText} numberOfLines={1}>
                        {emServico ? 'Sim' : 'Não'}
                      </Text>
                    </View>
                    <GHTouchableOpacity
                      style={styles.escalaRowCalBtn}
                      onPress={() => {
                        setEscalaCalendarioMesYm(escalaMesYm);
                        setEscalaCalendarioColaborador({
                          clienteId: mem.id,
                          nomeSobrenome: linhaNome,
                        });
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Calendário de ${linhaNome}, funcionário ${mem.id}`}
                    >
                      <Feather name="calendar" size={22} color="#5f4333" />
                    </GHTouchableOpacity>
                  </View>
                );
                /* Swipeable exige native + GestureHandlerRootView; no web costuma quebrar a árvore. */
                if (!podeSwipeDesligar || Platform.OS === 'web') return rowContent;
                return (
                  <Swipeable
                    /* Painel da esquerda com largura da tela: fundo vermelho preenche até a direita ao abrir. */
                    leftThreshold={Math.min(80, Math.max(48, Math.floor(windowWidth * 0.14)))}
                    renderLeftActions={() => (
                      <View
                        style={[
                          styles.escalaSwipeExcluirFundo,
                          { width: windowWidth },
                        ]}
                      >
                        <Feather name="trash-2" size={26} color="#fff" />
                      </View>
                    )}
                    overshootLeft={false}
                    friction={2}
                    enabled={
                      escalaDesligandoId == null &&
                      (escalaDesligarConfirm == null ||
                        escalaDesligarConfirm.colaboradorId === mem.id)
                    }
                    onSwipeableOpen={(direction, swipeable) => {
                      if (direction !== 'left' || escalaDesligandoId != null) return;
                      escalaSwipeDesligarRef.current = swipeable;
                      setEscalaDesligarConfirm({
                        colaboradorId: mem.id,
                        nomeExibicao: linhaNome,
                      });
                    }}
                    onSwipeableClose={() => {
                      escalaSwipeDesligarRef.current = null;
                      setEscalaDesligarConfirm((prev) =>
                        prev != null && prev.colaboradorId === mem.id ? null : prev
                      );
                    }}
                  >
                    {rowContent}
                  </Swipeable>
                );
              }}
            />
          )}
        </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={escalaDesligarConfirm != null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          fecharConfirmDesligarComSwipe();
        }}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => fecharConfirmDesligarComSwipe()}
            accessibilityRole="button"
            accessibilityLabel="Fechar confirma\u00e7\u00e3o de desligamento"
          />
          <View style={styles.escalaDesligarConfirmCard}>
            <View style={styles.escalaDesligarConfirmIconWrap}>
              <Feather name="alert-triangle" size={28} color="#8d3e32" />
            </View>
            <Text style={styles.escalaDesligarConfirmTitle}>Confirmar desligamento?</Text>
            <Text style={styles.escalaDesligarConfirmMessage}>
              {escalaDesligarConfirm
                ? `Registrar o desligamento de ${escalaDesligarConfirm.nomeExibicao} Id: #${escalaDesligarConfirm.colaboradorId}? Essa ação não poderá ser desfeita`
                : ''}
            </Text>
            <View style={styles.escalaDesligarConfirmActions}>
              <TouchableOpacity
                style={styles.escalaDesligarConfirmBtnSecondary}
                onPress={() => fecharConfirmDesligarComSwipe()}
                disabled={escalaDesligandoId != null}
                accessibilityRole="button"
                accessibilityLabel="Cancelar desligamento"
              >
                <Text style={styles.escalaDesligarConfirmBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.escalaDesligarConfirmBtnDanger,
                  escalaDesligandoId != null && styles.primaryButtonDisabled,
                ]}
                onPress={() => {
                  const c = escalaDesligarConfirm;
                  if (c == null) return;
                  const sw = escalaSwipeDesligarRef.current;
                  escalaSwipeDesligarRef.current = null;
                  setEscalaDesligarConfirm(null);
                  sw?.close();
                  void executarDesligarColaboradorEscala(c.colaboradorId);
                }}
                disabled={escalaDesligandoId != null}
                accessibilityRole="button"
                accessibilityLabel="Confirmar desligamento do colaborador"
              >
                {escalaDesligandoId != null ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.escalaDesligarConfirmBtnDangerText}>Desligar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={escalaCalendarioColaborador != null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeEscalaCalendarioColaborador}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={styles.escalaModalSafe} edges={['top', 'left', 'right']}>
          <View style={styles.escalaModalHeader}>
            <TouchableOpacity
              onPress={closeEscalaCalendarioColaborador}
              style={styles.funcionarioConfigCloseHit}
              accessibilityRole="button"
              accessibilityLabel="Fechar calendário"
            >
              <Feather name="arrow-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <View style={styles.funcionarioConfigTitleWrap}>
              <Text style={styles.funcionarioConfigTitle} numberOfLines={1}>
                Presença no mês
              </Text>
              {escalaCalendarioColaborador ? (
                <Text style={styles.escalaCalHeaderSubtitle} numberOfLines={2}>
                  {escalaCalendarioColaborador.nomeSobrenome}
                  <Text style={styles.escalaCalHeaderSubtitleId}>
                    {' '}
                    #{escalaCalendarioColaborador.clienteId}
                  </Text>
                </Text>
              ) : null}
            </View>
            <View style={styles.funcionarioConfigCloseHit} />
          </View>
          <View style={styles.escalaMesNav}>
            <TouchableOpacity
              onPress={() => {
                const [yy, mm] = escalaCalendarioMesYm.split('-').map((x) => Number(x));
                setEscalaCalendarioMesYm(formatAnoMes(new Date(yy, mm - 2, 1)));
              }}
              style={styles.escalaMesNavBtn}
              accessibilityRole="button"
              accessibilityLabel="Mês anterior"
            >
              <Feather name="chevron-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <Text style={styles.escalaMesNavLabel} numberOfLines={1}>
              {(() => {
                const [yy, mm] = escalaCalendarioMesYm.split('-').map((x) => Number(x));
                try {
                  return new Intl.DateTimeFormat('pt-BR', {
                    month: 'long',
                    year: 'numeric',
                  }).format(new Date(yy, mm - 1, 1));
                } catch {
                  return escalaCalendarioMesYm;
                }
              })()}
            </Text>
            <TouchableOpacity
              onPress={() => {
                const [yy, mm] = escalaCalendarioMesYm.split('-').map((x) => Number(x));
                setEscalaCalendarioMesYm(formatAnoMes(new Date(yy, mm, 1)));
              }}
              style={styles.escalaMesNavBtn}
              accessibilityRole="button"
              accessibilityLabel="Próximo mês"
            >
              <Feather name="chevron-right" size={24} color="#5f4333" />
            </TouchableOpacity>
          </View>
          <ScrollView
            nestedScrollEnabled
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: 20 + Math.max(insets.bottom, 10),
            }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.escalaCalLegendWrap}>
              <View style={styles.escalaCalLegendRow}>
                <View style={[styles.escalaCalLegendDot, styles.escalaCalLegendDotVerde]} />
                <Text style={styles.escalaCalLegendText}>Trabalhado</Text>
              </View>
              <View style={styles.escalaCalLegendRow}>
                <View style={[styles.escalaCalLegendDot, styles.escalaCalLegendDotVermelho]} />
                <Text style={styles.escalaCalLegendText}>Falta</Text>
              </View>
              <Text style={styles.escalaCalLegendHint}>
                {podeAtalhosGestaoCalendarioPresenca
                  ? 'Arraste: Direita = Folga (F) · Esquerda = Justificativa (J)'
                  : ''}
              </Text>
            </View>
            {escalaCalendarioPresencaLoading ? (
              <View style={styles.escalaListFooterLoading}>
                <ActivityIndicator color="#6a4b39" />
                <Text style={styles.escalaLoadingText}>Carregando a presença…</Text>
              </View>
            ) : null}
            {escalaCalendarioPresencaError ? (
              <Text style={styles.escalaErrorText}>{escalaCalendarioPresencaError}</Text>
            ) : null}
            {escalaCalendarioColaborador
              ? (() => {
                  const [yy, mm] = escalaCalendarioMesYm.split('-').map((x) => Number(x));
                  const pres = escalaCalendarioPresencaDias || {};
                  const first = new Date(yy, mm - 1, 1);
                  const lastDay = new Date(yy, mm, 0).getDate();
                  const pad = first.getDay();
                  const diasSemana = ['Dom.', 'Seg.', 'Ter.', 'Qua.', 'Qui.', 'Sex.', 'Sáb.'];
                  const cells: ({ d: number } | { empty: true })[] = [];
                  for (let i = 0; i < pad; i++) cells.push({ empty: true });
                  for (let d = 1; d <= lastDay; d++) cells.push({ d });
                  const iso = (day: number) =>
                    `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  return (
                    <>
                      <View style={styles.presencaWeekHeader}>
                        {diasSemana.map((letra, ix) => (
                          <Text key={String(ix)} style={styles.presencaWeekHeadCell}>
                            {letra}
                          </Text>
                        ))}
                      </View>
                      <View style={styles.presencaGrid}>
                        {cells.map((cell, ix) => {
                          if ('empty' in cell) {
                            return (
                              <View key={`e-${ix}`} style={styles.presencaDayCellWrap}>
                                <View style={styles.presencaDayCellEmptyFill} />
                              </View>
                            );
                          }
                          const dia = cell.d;
                          const keyDay = iso(dia);
                          const detDia = escalaCalendarioDiaDetalhes[keyDay];
                          const faltaMarcada = detDia?.falta === 'S';
                          const folgaMarcada = detDia?.folga === 'S';
                          const sit = pres[keyDay];
                          /* Falta registrada (detalhe) = vermelho. Senão: cor do toque rápido (PresencaDia) mesmo
                             com F ou J no mesmo dia — badges F/J continuam visíveis. */
                          const bgStyle = faltaMarcada
                            ? styles.presencaDayVermelho
                            : sit === 1
                              ? styles.presencaDayVerde
                              : sit === 0 || sit === 2
                                ? styles.presencaDayVermelho
                                : styles.presencaDayNeutro;
                          const temDetDia = Boolean(
                            detDia &&
                              (detDia.falta === 'S' ||
                                detDia.atestado === 'S' ||
                                detDia.folga === 'S' ||
                                (detDia.justificativa || '').trim().length > 0)
                          );
                          const mostrarJ = (detDia?.justificativa || '').trim().length > 0;
                          const mostrarF = folgaMarcada;
                          const mostrarBolinha =
                            temDetDia && !mostrarJ && !mostrarF;
                          const temBatidas = Boolean(
                            detDia?.entradaEm ||
                              detDia?.saidaAlmocoEm ||
                              detDia?.voltaAlmocoEm ||
                              detDia?.saidaExpedienteEm
                          );
                          const faltaBloqueiaCiclo =
                            faltaMarcada &&
                            ((detDia?.justificativa || '').trim().length > 0 ||
                              detDia?.atestado === 'S');
                          const podeCicloPresencaRapido =
                            podeAtalhosGestaoCalendarioPresenca &&
                            !temBatidas &&
                            !faltaBloqueiaCiclo;
                          const presencaSwipeNativo =
                            Platform.OS !== 'web' && podeAtalhosGestaoCalendarioPresenca;
                          const cellSaving =
                            escalaPresencaRapidaSaving === keyDay ||
                            escalaDetalheSwipeSaving === keyDay;
                          const marcacoesDia = (
                            <>
                              <Text style={styles.presencaDayNum}>{dia}</Text>
                              {mostrarJ ? (
                                <Text style={styles.presencaDayBadgeJ} accessibilityLabel="Justificado">
                                  J
                                </Text>
                              ) : null}
                              {mostrarF ? (
                                <Text style={styles.presencaDayBadgeF} accessibilityLabel="Folga">
                                  F
                                </Text>
                              ) : null}
                              {mostrarBolinha ? <View style={styles.presencaDayDetMark} /> : null}
                            </>
                          );
                          return (
                            <View key={keyDay} style={styles.presencaDayCellWrap}>
                              {presencaSwipeNativo ? (
                                <Swipeable
                                  enabled={!cellSaving}
                                  friction={2}
                                  overshootLeft={false}
                                  overshootRight={false}
                                  leftThreshold={36}
                                  rightThreshold={36}
                                  renderLeftActions={() => (
                                    <View style={styles.presencaDaySwipeActionFolga}>
                                      <Text style={styles.presencaDaySwipeActionText}>F</Text>
                                    </View>
                                  )}
                                  renderRightActions={() => (
                                    <View style={styles.presencaDaySwipeActionJust}>
                                      <Text style={styles.presencaDaySwipeActionText}>J</Text>
                                    </View>
                                  )}
                                  onSwipeableOpen={(direction, sw) => {
                                    void executarSwipeCalendarioDia(
                                      keyDay,
                                      direction === 'left' ? 'left' : 'right',
                                      sw
                                    );
                                  }}
                                >
                                  <GHTouchableOpacity
                                    delayLongPress={550}
                                    disabled={cellSaving}
                                    activeOpacity={0.82}
                                    onLongPress={() => {
                                      presencaCalLongPressRef.current = true;
                                      abrirPontoDiaModal(keyDay);
                                      setTimeout(() => {
                                        presencaCalLongPressRef.current = false;
                                      }, 500);
                                    }}
                                    onPress={() => {
                                      if (presencaCalLongPressRef.current) return;
                                      if (podeCicloPresencaRapido) {
                                        void aplicarPresencaDiaRapido(keyDay);
                                      }
                                    }}
                                    style={[
                                      styles.presencaDayCell,
                                      bgStyle,
                                      cellSaving ? { opacity: 0.65 } : null,
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={
                                      podeCicloPresencaRapido
                                        ? `Dia ${dia}. Toque para alternar presença. Arraste para folga ou justificativa. Segure para detalhes.`
                                        : `Dia ${dia}. Arraste para folga ou justificativa. Segure para detalhes.`
                                    }
                                  >
                                    {marcacoesDia}
                                  </GHTouchableOpacity>
                                </Swipeable>
                              ) : (
                                <Pressable
                                  delayLongPress={550}
                                  disabled={cellSaving}
                                  onLongPress={() => {
                                    presencaCalLongPressRef.current = true;
                                    abrirPontoDiaModal(keyDay);
                                    setTimeout(() => {
                                      presencaCalLongPressRef.current = false;
                                    }, 500);
                                  }}
                                  onPress={() => {
                                    if (presencaCalLongPressRef.current) return;
                                    if (podeCicloPresencaRapido) {
                                      void aplicarPresencaDiaRapido(keyDay);
                                    }
                                  }}
                                  style={({ pressed }) => [
                                    styles.presencaDayCell,
                                    bgStyle,
                                    pressed && podeCicloPresencaRapido ? { opacity: 0.88 } : null,
                                    cellSaving ? { opacity: 0.65 } : null,
                                  ]}
                                  accessibilityRole="button"
                                  accessibilityLabel={
                                    podeCicloPresencaRapido
                                      ? `Dia ${dia}. Toque para alternar presença. Segure cerca de meio segundo para detalhes.`
                                      : `Dia ${dia}. Segure cerca de meio segundo para abrir detalhes.`
                                  }
                                >
                                  {marcacoesDia}
                                </Pressable>
                              )}
                            </View>
                          );
                        })}
                      </View>
                    </>
                  );
                })()
              : null}
          </ScrollView>
        </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={escalaPontoDiaModal != null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={tentarFecharModalDetalhesDia}
      >
        <SafeAreaView style={styles.escalaModalSafe} edges={['top', 'left', 'right']}>
          <View style={styles.escalaModalHeader}>
            <TouchableOpacity
              onPress={tentarFecharModalDetalhesDia}
              style={styles.funcionarioConfigCloseHit}
              accessibilityRole="button"
              accessibilityLabel="Fechar detalhes do dia"
            >
              <Feather name="arrow-left" size={24} color="#5f4333" />
            </TouchableOpacity>
            <View style={styles.funcionarioConfigTitleWrap}>
              <Text style={styles.funcionarioConfigTitle} numberOfLines={2}>
                Detalhes do dia
              </Text>
            </View>
            <View style={styles.funcionarioConfigCloseHit} />
          </View>
          <ScrollView
            style={styles.pontoDiaModalScroll}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: 24 + Math.max(insets.bottom, 8),
            }}
            keyboardShouldPersistTaps="handled"
          >
            {escalaPontoDiaModal ? (
              <Text style={styles.pontoDiaModalDataTitulo}>
                {(() => {
                  const p = escalaPontoDiaModal.diaIso.split('-').map((x) => Number(x));
                  const [yy, mm, dd] = p;
                  try {
                    return new Intl.DateTimeFormat('pt-BR', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    }).format(new Date(yy, mm - 1, dd));
                  } catch {
                    return escalaPontoDiaModal.diaIso;
                  }
                })()}
              </Text>
            ) : null}
            <Text style={styles.pontoDiaModalLabel}>Falta</Text>
            <View style={styles.pontoDiaModalSimNaoRow}>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  !pontoDiaFaltaSim && styles.pontoDiaModalChipOn,
                  pontoDiaPermissoesUi.travarFalta && styles.pontoDiaModalChipLocked,
                ]}
                onPress={() => setPontoDiaFaltaSim(false)}
                disabled={pontoDiaSaving || pontoDiaPermissoesUi.travarFalta}
              >
                <Text
                  style={[!pontoDiaFaltaSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText]}
                >
                  Não
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  pontoDiaFaltaSim && styles.pontoDiaModalChipOnSim,
                  pontoDiaPermissoesUi.travarFalta && styles.pontoDiaModalChipLocked,
                ]}
                onPress={() => {
                  setPontoDiaFaltaSim(true);
                  setPontoDiaFolgaSim(false);
                }}
                disabled={pontoDiaSaving || pontoDiaPermissoesUi.travarFalta}
              >
                <Text
                  style={[pontoDiaFaltaSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText]}
                >
                  Sim
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.pontoDiaModalLabel}>Atestado</Text>
            <View style={styles.pontoDiaModalSimNaoRow}>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  !pontoDiaAtestadoSim && styles.pontoDiaModalChipOn,
                ]}
                onPress={() => setPontoDiaAtestadoSim(false)}
              >
                <Text
                  style={[
                    !pontoDiaAtestadoSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText,
                  ]}
                >
                  Não
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  pontoDiaAtestadoSim && styles.pontoDiaModalChipOnSim,
                ]}
                onPress={() => setPontoDiaAtestadoSim(true)}
              >
                <Text
                  style={[
                    pontoDiaAtestadoSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText,
                  ]}
                >
                  Sim
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.pontoDiaModalLabel}>Folga</Text>
            <View style={styles.pontoDiaModalSimNaoRow}>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  !pontoDiaFolgaSim && styles.pontoDiaModalChipOn,
                  pontoDiaPermissoesUi.travarFolga && styles.pontoDiaModalChipLocked,
                ]}
                onPress={() => setPontoDiaFolgaSim(false)}
                disabled={pontoDiaSaving || pontoDiaPermissoesUi.travarFolga}
              >
                <Text
                  style={[!pontoDiaFolgaSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText]}
                >
                  Não
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.pontoDiaModalChip,
                  pontoDiaFolgaSim && styles.pontoDiaModalChipOnSim,
                  pontoDiaPermissoesUi.travarFolga && styles.pontoDiaModalChipLocked,
                ]}
                onPress={() => {
                  setPontoDiaFolgaSim(true);
                  setPontoDiaFaltaSim(false);
                }}
                disabled={pontoDiaSaving || pontoDiaPermissoesUi.travarFolga}
              >
                <Text
                  style={[pontoDiaFolgaSim ? styles.pontoDiaModalChipTextOn : styles.pontoDiaModalChipText]}
                >
                  Sim
                </Text>
              </TouchableOpacity>
            </View>
            {escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ ? (
              <Text style={styles.pontoDiaModalJustObrigHint}>
                Preencha a justificativa abaixo — é obrigatória após o gesto no calendário. Para sair sem
                gravar, use a seta voltar e confirme.
              </Text>
            ) : null}
            <Text style={styles.pontoDiaModalLabel}>
              Justificativa
              {escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ ? (
                <Text style={styles.pontoDiaModalLabelObrig}> (obrigatória)</Text>
              ) : null}
            </Text>
            <TextInput
              ref={pontoDiaJustificativaInputRef}
              value={pontoDiaJustificativa}
              onChangeText={(t) => setPontoDiaJustificativa(t.slice(0, 2000))}
              placeholder={
                escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ
                  ? 'Descreva o motivo (obrigatório)'
                  : 'Opcional'
              }
              placeholderTextColor="#9a8a7f"
              multiline
              maxLength={2000}
              /* scrollEnabled: evita scroll aninhado com ScrollView pai no Android ao focar. */
              scrollEnabled
              style={[
                styles.pontoDiaModalJustInput,
                pontoDiaPermissoesUi.travarJust ? styles.pontoDiaModalJustInputLocked : null,
                escalaPontoDiaModal?.obrigarJustificativaPosSwipeJ
                  ? styles.pontoDiaModalJustInputObrigatorio
                  : null,
              ]}
              editable={!pontoDiaSaving && !pontoDiaPermissoesUi.travarJust}
            />
            {escalaCalendarioColaborador &&
            escalaPontoDiaModal &&
            pontoDiaGestaoColaboradorCalendario ? (
              <>
                <Text style={styles.pontoDiaModalLabel}>Foto do atestado</Text>
                <Text style={styles.pontoDiaModalFotoHint}>
                  Anexe pela galeria ou tire uma foto.
                </Text>
                {(() => {
                  const detImg =
                    escalaCalendarioDiaDetalhes[escalaPontoDiaModal.diaIso];
                  const uriPrev =
                    pontoDiaAtestadoImagemPending ??
                    (pontoDiaRemoverAtestadoImagem
                      ? null
                      : (detImg?.atestadoImagem ?? null));
                  const temAnexo =
                    typeof uriPrev === 'string' && uriPrev.trim().length > 0;
                  const podeRemover =
                    temAnexo ||
                    !!pontoDiaAtestadoImagemPending ||
                    (!!detImg?.atestadoImagem && !pontoDiaRemoverAtestadoImagem);
                  return (
                    <>
                      {temAnexo ? (
                        <TouchableOpacity
                          activeOpacity={0.92}
                          onPress={() => setAtestadoImagemFullscreenUri(uriPrev as string)}
                          accessibilityRole="button"
                          accessibilityLabel="Ampliar foto do atestado"
                        >
                          <Image
                            source={{ uri: uriPrev as string }}
                            style={styles.pontoDiaModalAtestPreview}
                            resizeMode="contain"
                          />
                        </TouchableOpacity>
                      ) : (
                        <Text style={styles.pontoDiaModalFotoHintMuted}>
                          Nenhuma foto anexada.
                        </Text>
                      )}
                      <View style={styles.pontoDiaModalFotoBtns}>
                        <TouchableOpacity
                          style={[
                            styles.pontoDiaModalFotoBtn,
                            pontoDiaSaving && styles.pontoDiaModalFotoBtnDisabled,
                          ]}
                          onPress={() => void pickAtestadoImagemParaPontoDia()}
                          disabled={pontoDiaSaving}
                          accessibilityRole="button"
                          accessibilityLabel="Anexar foto do atestado pela galeria"
                        >
                          <Feather name="image" size={18} color="#5f4333" />
                          <Text style={styles.pontoDiaModalFotoBtnText}>Galeria</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.pontoDiaModalFotoBtn,
                            pontoDiaSaving && styles.pontoDiaModalFotoBtnDisabled,
                          ]}
                          onPress={() => void tirarFotoAtestadoPontoDiaCamera()}
                          disabled={pontoDiaSaving}
                          accessibilityRole="button"
                          accessibilityLabel="Tirar foto do atestado com a câmera"
                        >
                          <Feather name="camera" size={18} color="#5f4333" />
                          <Text style={styles.pontoDiaModalFotoBtnText}>Câmera</Text>
                        </TouchableOpacity>
                        {podeRemover ? (
                          <TouchableOpacity
                            style={[
                              styles.pontoDiaModalFotoBtn,
                              styles.pontoDiaModalFotoBtnDanger,
                              pontoDiaSaving && styles.pontoDiaModalFotoBtnDisabled,
                            ]}
                            onPress={() => {
                              setPontoDiaRemoverAtestadoImagem(true);
                              setPontoDiaAtestadoImagemPending(null);
                            }}
                            disabled={pontoDiaSaving}
                            accessibilityRole="button"
                            accessibilityLabel="Remover foto do atestado"
                          >
                            <Feather name="trash-2" size={18} color="#8b3a2a" />
                            <Text style={styles.pontoDiaModalFotoBtnTextDanger}>Remover</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </>
                  );
                })()}
              </>
            ) : null}
            {pontoDiaError ? <Text style={styles.escalaErrorText}>{pontoDiaError}</Text> : null}
            <TouchableOpacity
              style={[styles.primaryButton, pontoDiaSaving && { opacity: 0.7 }]}
              onPress={() => void salvarPontoDiaModal()}
              disabled={pontoDiaSaving}
            >
              {pontoDiaSaving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>Salvar</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={pontoDiaJustObrigConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPontoDiaJustObrigConfirmVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setPontoDiaJustObrigConfirmVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Continuar preenchendo a justificativa"
          />
          <View style={styles.pontoDiaJustObrigConfirmCard}>
            <View style={styles.pontoDiaJustObrigIconWrap}>
              <Feather name="edit-3" size={26} color="#6a4428" />
            </View>
            <Text style={styles.pontoDiaJustObrigTitle}>Justificativa obrigatória</Text>
            <Text style={styles.pontoDiaJustObrigSubtitle}>
              Você abriu este dia pelo gesto <Text style={styles.pontoDiaJustObrigEm}>J</Text> no
              calendário. Para concluir:
            </Text>
            <View style={styles.pontoDiaJustObrigBullets}>
              <View style={styles.pontoDiaJustObrigBulletRow}>
                <View style={styles.pontoDiaJustObrigBulletDot} />
                <Text style={styles.pontoDiaJustObrigBulletText}>
                  Escreva o motivo no campo abaixo e toque em{' '}
                  <Text style={styles.pontoDiaJustObrigEm}>Salvar</Text>.
                </Text>
              </View>
              <View style={[styles.pontoDiaJustObrigBulletRow, styles.pontoDiaJustObrigBulletRowLast]}>
                <View style={styles.pontoDiaJustObrigBulletDot} />
                <Text style={styles.pontoDiaJustObrigBulletText}>
                  Se sair sem salvar, a ação no calendário não será registrada.
                </Text>
              </View>
            </View>
            <View style={styles.pontoDiaJustObrigActions}>
              <TouchableOpacity
                style={styles.pontoDiaJustObrigBtnPrimary}
                onPress={() => setPontoDiaJustObrigConfirmVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Continuar preenchendo"
              >
                <Text style={styles.pontoDiaJustObrigBtnPrimaryText}>Continuar preenchendo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pontoDiaJustObrigBtnGhost}
                onPress={() => {
                  setPontoDiaJustObrigConfirmVisible(false);
                  setEscalaPontoDiaModal(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Sair sem salvar justificativa"
              >
                <Text style={styles.pontoDiaJustObrigBtnGhostText}>Sair sem salvar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={atestadoImagemFullscreenUri != null}
        animationType="fade"
        presentationStyle="fullScreen"
        statusBarTranslucent
        onRequestClose={() => setAtestadoImagemFullscreenUri(null)}
      >
        <SafeAreaView style={styles.atestadoFullscreenSafe} edges={['top', 'left', 'right', 'bottom']}>
          <View style={styles.atestadoFullscreenHeader}>
            <TouchableOpacity
              onPress={() => setAtestadoImagemFullscreenUri(null)}
              style={styles.atestadoFullscreenCloseHit}
              accessibilityRole="button"
              accessibilityLabel="Fechar foto ampliada"
            >
              <Feather name="x" size={28} color="#fff" />
            </TouchableOpacity>
          </View>
          <Pressable
            style={styles.atestadoFullscreenImageWrap}
            onPress={() => setAtestadoImagemFullscreenUri(null)}
            accessibilityRole="button"
            accessibilityLabel="Fechar foto ampliada"
          >
            {atestadoImagemFullscreenUri ? (
              <Image
                source={{ uri: atestadoImagemFullscreenUri }}
                style={StyleSheet.absoluteFillObject}
                resizeMode="contain"
              />
            ) : null}
          </Pressable>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={funcionarioAuthVisible}
        transparent
        animationType="fade"
        onRequestClose={closeFuncionarioAuth}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={closeFuncionarioAuth}
            accessibilityRole="button"
            accessibilityLabel="Fechar autorização de funcionário"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Autorizar cadastro</Text>
            <TextInput
              value={funcionarioAdminPass}
              onChangeText={(t) => {
                setFuncionarioAdminPass(t);
                if (funcionarioAuthPassError) setFuncionarioAuthPassError('');
              }}
              placeholder="Senha de autorização"
              secureTextEntry
              placeholderTextColor="#9a8a7f"
              style={[styles.input, funcionarioAuthPassError ? styles.inputError : null]}
            />
            {funcionarioAuthPassError ? (
              <Text style={styles.fieldErrorText}>{funcionarioAuthPassError}</Text>
            ) : null}
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={styles.profileEditCancelBtn}
                onPress={closeFuncionarioAuth}
              >
                <Text style={styles.profileEditCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, styles.profileEditSaveBtn]}
                onPress={() => void confirmFuncionarioAuth()}
              >
                <Text style={styles.primaryButtonText}>Validar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={funcionarioProfileVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFuncionarioProfileVisible(false)}
      >
        <View style={styles.profileEditBackdrop}>
          <BlurView intensity={55} tint="dark" style={styles.profileEditBackdropFill} />
          <Pressable
            style={styles.profileEditBackdropFill}
            onPress={() => setFuncionarioProfileVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar cadastro de funcionário"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Cadastro de funcionário</Text>
            <TextInput
              value={funcionarioSetor}
              onChangeText={setFuncionarioSetor}
              placeholder="Setor"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!funcionarioSaving}
            />
            <TextInput
              value={funcionarioCargo}
              onChangeText={setFuncionarioCargo}
              placeholder="Cargo"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!funcionarioSaving}
            />
            <TextInput
              value={funcionarioNivel}
              onChangeText={setFuncionarioNivel}
              placeholder="Nível"
              placeholderTextColor="#9a8a7f"
              style={styles.input}
              editable={!funcionarioSaving}
            />
            <View style={styles.profileEditActions}>
              <TouchableOpacity
                style={styles.profileEditCancelBtn}
                onPress={() => setFuncionarioProfileVisible(false)}
                disabled={funcionarioSaving}
              >
                <Text style={styles.profileEditCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.profileEditSaveBtn,
                  funcionarioSaving && styles.primaryButtonDisabled,
                ]}
                onPress={() => void saveFuncionarioProfile()}
                disabled={funcionarioSaving}
              >
                {funcionarioSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Salvar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <StatusBar style={introVisible ? 'light' : 'dark'} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f6f4f2',
  },
  /** Enquanto o splash React está visível: mesma cor do bokeh (evita faixa clara sob o status bar). */
  safeAreaSplash: {
    backgroundColor: '#1a1411',
  },
  container: {
    flex: 1,
    backgroundColor: '#f6f4f2',
    paddingHorizontal: 22,
    paddingTop: 22,
  },
  containerUnderSplash: {
    backgroundColor: '#1a1411',
  },
  /** Splash em tela cheia, acima do conteúdo com área segura. */
  introOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
    elevation: 999,
  },
  introBackdrop: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  introLogoCenterWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  introSplashColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  introFelizHoje: {
    marginTop: 34,
    fontSize: 32,
    fontWeight: '800',
    color: '#4a2818',
    letterSpacing: 0.6,
    textShadowColor: 'rgba(255,255,255,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  introAppIcon: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  /** Ingressos: mesmo bokeh do splash, fora do padding do container (evita sumir atrás das camadas). */
  ingressosFullBleed: {
    flex: 1,
    zIndex: 2,
    elevation: 2,
    minHeight: 280,
  },
  ingressosFullBleedImage: {
    width: '100%',
    height: '100%',
  },
  ingressosFullBleedDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(26,20,17,0.35)',
  },
  ingressosContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    zIndex: 1,
  },
  ingressosPopup: {
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 18,
    paddingVertical: 22,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.28)',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
    maxWidth: 360,
    width: '100%',
  },
  ingressosPopupRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ingressosPopupTitle: {
    flex: 1,
    flexShrink: 1,
    marginLeft: 14,
    fontSize: 17,
    fontWeight: '700',
    color: '#3d1f12',
    letterSpacing: 0.15,
    lineHeight: 24,
  },
  backgroundImage: {
    ...StyleSheet.absoluteFillObject,
  },
  backgroundImageStyle: {
    opacity: 0.42,
  },
  textureOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    opacity: 0.8,
  },
  embossLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  cocoaIcon: {
    position: 'absolute',
    width: 92,
    height: 52,
    opacity: 0.11,
  },
  cocoaIconLarge: {
    position: 'absolute',
    width: 120,
    height: 66,
    opacity: 0.09,
  },
  embossOne: {
    top: 42,
    left: 10,
    transform: [{ rotate: '16deg' }],
  },
  embossTwo: {
    top: 104,
    right: 14,
    transform: [{ rotate: '-14deg' }],
  },
  embossThree: {
    top: 462,
    left: 10,
    transform: [{ rotate: '12deg' }],
  },
  embossFour: {
    bottom: 206,
    right: 10,
    transform: [{ rotate: '-18deg' }],
  },
  embossFive: {
    bottom: 108,
    left: 18,
    transform: [{ rotate: '10deg' }],
  },
  embossPodOne: {
    top: 220,
    left: 2,
    transform: [{ rotate: '22deg' }],
  },
  embossPodTwo: {
    top: 304,
    right: 0,
    transform: [{ rotate: '-16deg' }],
  },
  embossPodThree: {
    bottom: 282,
    left: 70,
    transform: [{ rotate: '14deg' }],
  },
  embossPodFour: {
    bottom: 56,
    right: 68,
    transform: [{ rotate: '-10deg' }],
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 76,
    height: 66,
    borderRadius: 36,
  },
  iconBubble: {
    width: 48,
    height: 48,
    aspectRatio: 1,
    borderRadius: 999,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  activeIconBubble: {
    backgroundColor: '#7b4228',
    borderRadius: 999,
  },
  navIcon: {
    fontSize: 20,
    color: '#6c4a35',
    marginBottom: 2,
  },
  navLabel: {
    fontSize: 12,
    color: '#4a3428',
    fontWeight: '600',
  },
  activeNavLabel: {
    fontSize: 12,
    color: '#3e291f',
    fontWeight: '700',
  },
  brandTitle: {
    fontSize: 52,
    color: '#3d1f12',
    fontWeight: '700',
    marginBottom: 5,
  },
  subtitle: {
    fontSize: 24,
    color: '#8b735f',
    textAlign: 'center',
    marginBottom: 24,
  },
  mapTabOuter: {
    flex: 1,
    backgroundColor: '#f6f4f2',
  },
  mapTopChocolateBar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#7b4228',
    paddingHorizontal: 16,
  },
  mapTopChocolateTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  mapLegendButton: {
    padding: 8,
    marginRight: -4,
  },
  mapContainer: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingHorizontal: 0,
  },
  mapLegendBackdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  mapLegendBackdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  mapLegendCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fffbf7',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingBottom: 16,
    paddingTop: 6,
    borderWidth: 1,
    borderColor: 'rgba(123, 66, 40, 0.2)',
    zIndex: 1,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  mapLegendCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 8,
  },
  mapLegendCardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4a2c1c',
  },
  mapLegendCloseBtn: {
    padding: 8,
    marginRight: -4,
  },
  mapLegendCloseBtnText: {
    fontSize: 20,
    color: '#7b4228',
    fontWeight: '800',
  },
  mapLegendHint: {
    fontSize: 13,
    color: '#8b735f',
    marginBottom: 8,
    lineHeight: 18,
  },
  mapLegendScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  mapLegendScrollContent: {
    paddingBottom: 18,
  },
  mapLegendSection: {
    marginBottom: 6,
  },
  mapLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(123, 66, 40, 0.08)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  mapLegendRowText: {
    flex: 1,
  },
  mapLegendRowTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#3d2415',
  },
  mapLegendRowSub: {
    fontSize: 12,
    color: '#7a6658',
    marginTop: 2,
  },
  mapLegendList: {
    marginTop: 6,
    marginLeft: 8,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(123, 66, 40, 0.25)',
  },
  mapLegendListEmpty: {
    fontSize: 13,
    color: '#9a8a7f',
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  mapLegendListItem: {
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  mapLegendListItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mapLegendClosedIcon: {
    marginLeft: 8,
  },
  mapLegendQueueMini: {
    marginLeft: 8,
    minWidth: 24,
    textAlign: 'right',
    fontSize: 12,
    fontWeight: '700',
    color: '#7b4228',
  },
  mapLegendListItemText: {
    flex: 1,
    fontSize: 15,
    color: '#5c3d2e',
    fontWeight: '600',
    paddingRight: 8,
  },
  mapLegendListItemMeta: {
    fontSize: 12,
    color: '#8b735f',
    marginTop: 6,
    lineHeight: 17,
  },
  mapLegendListItemDesc: {
    fontSize: 13,
    color: '#6a5545',
    marginTop: 6,
    lineHeight: 18,
  },
  mapGestureFrame: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-start',
    alignItems: 'center',
    overflow: 'hidden',
  },
  mapContentFrame: {
    position: 'relative',
  },
  mapContentImage: {
    width: '100%',
    height: '100%',
  },
  // Área de toque maior que o desenho; o círculo visível é só o filho centralizado.
  mapHotspot: {
    position: 'absolute',
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapHotspotMarkWrap: {
    width: MAP_HOTSPOT_MARK_SIZE + 36,
    height: MAP_HOTSPOT_MARK_SIZE + 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapHotspotShineHalo: {
    position: 'absolute',
  },
  mapHotspotPulseRing: {
    position: 'absolute',
    borderWidth: 2,
  },
  mapLegendIconWrap: {
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapHotspotGlow: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    shadowColor: '#7a5608',
    shadowOpacity: 0.42,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  mapHotspotCoinGloss: {
    position: 'absolute',
    top: 4,
    left: 6,
    right: 6,
    height: 10,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.42)',
    zIndex: 1,
  },
  mapHotspotCoinTint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(244, 191, 26, 0.28)',
    zIndex: 1,
  },
  mapHotspotIcon: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  mapInfoSheet: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.18)',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  mapInfoHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 8,
  },
  mapInfoTitle: {
    fontSize: 21,
    fontWeight: '800',
    color: '#3d1f12',
    marginBottom: 8,
    lineHeight: 26,
  },
  mapInfoFila: {
    fontSize: 16,
    fontWeight: '800',
    color: '#5c2e18',
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  mapInfoDetailLine: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7a6252',
    marginTop: 5,
  },
  mapInfoAttractionImage: {
    width: '100%',
    height: 152,
    borderRadius: 16,
    marginTop: 14,
    marginBottom: -4,
  },
  mapInfoClose: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(123,66,40,0.08)',
  },
  mapInfoCloseText: {
    fontSize: 16,
    fontWeight: '900',
    color: '#7b4228',
  },
  mapImage: {
    width: '100%',
    alignSelf: 'center',
  },
  storeCard: {
    width: '100%',
    borderRadius: 20,
    overflow: 'hidden',
  },
  slideWrapper: {
    width: '100%',
  },
  storeImage: {
    height: 255,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 16,
    backgroundColor: '#442615',
  },
  storeImageRadius: {
    borderRadius: 20,
  },
  storeText: {
    fontSize: 34,
    color: '#fff',
    fontWeight: '800',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 4 },
    textShadowRadius: 7,
  },
  /** Hotéis na home: respiro nas laterais e título centralizado em várias linhas. */
  hotelCarouselImage: {
    alignItems: 'stretch',
    paddingHorizontal: 22,
  },
  hotelCarouselTitle: {
    textAlign: 'center',
  },
  indicatorRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
  },
  indicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#cdbfb3',
  },
  indicatorDotActive: {
    width: 18,
    backgroundColor: '#7b4228',
  },
  bottomNav: {
    position: 'absolute',
    zIndex: 30,
    bottom: 0,
    left: -22,
    right: -22,
    minHeight: 68,
    paddingTop: 8,
    paddingHorizontal: 6,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    backgroundColor: '#f6f4f2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 30,
  },
  profileConfigFab: {
    position: 'absolute',
    zIndex: 35,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(246, 244, 242, 0.82)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(123, 66, 40, 0.38)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  funcionarioConfigModalRoot: {
    flex: 1,
    backgroundColor: '#f6f4f2',
  },
  funcionarioConfigForeground: {
    flex: 1,
    zIndex: 1,
  },
  funcionarioConfigTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 12,
    backgroundColor: '#f6f4f2',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.22)',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  funcionarioConfigCloseHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  funcionarioConfigTitleWrap: {
    flex: 1,
  },
  funcionarioConfigTitle: {
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: '#5f4333',
    letterSpacing: 0.2,
  },
  escalaCalHeaderSubtitle: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: '#6a4b39',
    marginTop: 2,
    paddingHorizontal: 4,
  },
  escalaCalHeaderSubtitleId: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9a8a7f',
  },
  funcionarioConfigScroll: {
    flex: 1,
  },
  funcionarioConfigScrollContent: {
    flexGrow: 1,
  },
  funcionarioConfigFooter: {
    paddingTop: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f0ebe6',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(122,98,82,0.28)',
  },
  funcionarioConfigEmServicoTitulo: {
    fontSize: 17,
    fontWeight: '700',
    color: '#3d2918',
    textAlign: 'center',
    marginBottom: 8,
  },
  funcionarioConfigEmServicoSub: {
    fontSize: 12,
    lineHeight: 17,
    color: '#6b5344',
    textAlign: 'center',
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  funcionarioConfigEmServicoRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'stretch',
  },
  funcionarioConfigEmServicoBtn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  funcionarioConfigEmServicoBtnSim: {
    backgroundColor: '#2e7d4a',
    shadowColor: '#1b5e20',
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  funcionarioConfigEmServicoBtnNao: {
    backgroundColor: '#c62828',
    shadowColor: '#8b0000',
    shadowOpacity: 0.26,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  funcionarioConfigEmServicoBtnSelSim: {
    borderColor: 'rgba(255,255,255,0.95)',
    transform: [{ scale: 1.04 }],
    shadowOpacity: 0.4,
    elevation: 8,
  },
  funcionarioConfigEmServicoBtnSelNao: {
    borderColor: 'rgba(255,255,255,0.95)',
    transform: [{ scale: 1.04 }],
    shadowOpacity: 0.38,
    elevation: 8,
  },
  funcionarioConfigEmServicoBtnUnsel: {
    opacity: 0.48,
    elevation: 1,
    shadowOpacity: 0.08,
    transform: [{ scale: 0.97 }],
  },
  funcionarioConfigEmServicoBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 17,
    letterSpacing: 0.4,
  },
  funcionarioConfigEmServicoBtnSub: {
    color: 'rgba(255,255,255,0.92)',
    fontWeight: '600',
    fontSize: 11,
    marginTop: 3,
    textAlign: 'center',
  },
  cadastroCargosScroll: {
    flex: 1,
  },
  cadastroCargosLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5f4333',
    marginBottom: 6,
  },
  cadastroCargosPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.35)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  cadastroCargosPickerBtnText: {
    flex: 1,
    fontSize: 15,
    color: '#3d2918',
  },
  cadastroCargosPickerBtnPlaceholder: {
    color: '#9a8a7f',
  },
  cadastroCargosPickerModalRoot: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  cadastroCargosPickerModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cadastroCargosPickerCard: {
    backgroundColor: '#faf7f4',
    borderRadius: 16,
    padding: 16,
    maxHeight: '72%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.25)',
  },
  cadastroCargosPickerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#3d2918',
    marginBottom: 12,
  },
  cadastroCargosPickerScroll: {
    maxHeight: 360,
  },
  cadastroCargosPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.15)',
  },
  cadastroCargosPickerRowNome: {
    flex: 1,
    fontSize: 15,
    color: '#3d2918',
    fontWeight: '600',
  },
  cadastroCargosPickerRowOrd: {
    fontSize: 12,
    color: '#7a6a5f',
    fontWeight: '500',
  },
  cadastroCargosPickerFechar: {
    marginTop: 12,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  cadastroCargosPickerFecharText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#6a4b39',
  },
  cadastroCargosInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.35)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#3d2918',
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  cadastroCargosInputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  cadastroCargosInputError: {
    borderColor: '#c62828',
    borderWidth: 1.5,
  },
  cadastroCargosFieldErrText: {
    fontSize: 12,
    color: '#c62828',
    marginTop: -6,
    marginBottom: 10,
  },
  cadastroCargosSalvarBtn: {
    backgroundColor: '#5f4333',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  cadastroCargosSalvarBtnDisabled: {
    opacity: 0.45,
  },
  cadastroCargosSalvarBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  cadastroCargosSecTitulo: {
    fontSize: 16,
    fontWeight: '700',
    color: '#3d2918',
    marginTop: 8,
    marginBottom: 10,
  },
  cadastroCargosRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.18)',
    gap: 8,
  },
  cadastroCargosRowText: {
    flex: 1,
  },
  cadastroCargosRowNome: {
    fontSize: 15,
    fontWeight: '600',
    color: '#3d2918',
  },
  cadastroCargosRowMeta: {
    fontSize: 12,
    color: '#6b5344',
    marginTop: 3,
  },
  cadastroCargosRowDesc: {
    fontSize: 12,
    color: '#6b5344',
    marginTop: 4,
  },
  cadastroCargosBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(95,67,51,0.12)',
  },
  cadastroCargosBadgeCadastro: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(46,125,74,0.15)',
  },
  cadastroCargosBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#5f4333',
  },
  escalaModalSafe: {
    flex: 1,
    backgroundColor: '#f6f4f2',
  },
  escalaModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 8,
    backgroundColor: '#f0ebe6',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.22)',
  },
  escalaMesNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#faf8f6',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.15)',
  },
  escalaMesNavBtn: {
    padding: 10,
    minWidth: 44,
    alignItems: 'center',
  },
  escalaMesNavLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: '700',
    color: '#5f4333',
    textTransform: 'capitalize',
    textAlign: 'center',
  },
  escalaEquipeHeaderSub: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: '#7a6a5e',
    marginTop: 2,
    paddingHorizontal: 8,
    lineHeight: 16,
  },
  escalaFiltroRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  escalaFiltroChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#e8e2dc',
    alignItems: 'center',
  },
  escalaFiltroChipOn: {
    backgroundColor: '#6a4b39',
  },
  escalaFiltroChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#5f4333',
  },
  escalaFiltroChipTextOn: {
    color: '#fff',
  },
  escalaBuscaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.2)',
  },
  escalaBuscaIcon: {
    marginRight: 8,
  },
  escalaBuscaInput: {
    flex: 1,
    fontSize: 15,
    color: '#3d2918',
    paddingVertical: 4,
  },
  escalaBuscaClear: {
    padding: 6,
    marginLeft: 4,
  },
  escalaLoadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  escalaLoadingText: {
    marginTop: 10,
    color: '#6b5344',
  },
  escalaErrorText: {
    color: '#b71c1c',
    textAlign: 'center',
    marginBottom: 12,
  },
  escalaRetryBtn: {
    backgroundColor: '#6a4b39',
    paddingHorizontal:20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  escalaRetryBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
  escalaListaScroll: {
    flex: 1,
  },
  escalaListFooterLoading: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  escalaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.14)',
    backgroundColor: '#fff',
  },
  escalaRowDesligadoMes: {
    backgroundColor: 'rgba(230, 120, 110, 0.1)',
  },
  escalaRowNomeRiscado: {
    textDecorationLine: 'line-through',
    color: '#6b5344',
  },
  escalaRowTextBlock: {
    flex: 1,
    minWidth: 0,
    marginRight: 8,
  },
  escalaRowNameLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  escalaRowNomeCompleto: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#3d2918',
  },
  escalaRowIdBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9a8a7f',
  },
  escalaRowSetorCargo: {
    fontSize: 12,
    color: '#6b5344',
    marginTop: 2,
  },
  escalaRowPill: {
    marginLeft: 0,
    flexShrink: 0,
  },
  escalaRowCalBtn: {
    padding: 10,
    marginLeft: 4,
  },
  escalaRowDesligandoOpacity: {
    opacity: 0.72,
  },
  escalaSwipeExcluirFundo: {
    alignSelf: 'stretch',
    minHeight: 56,
    backgroundColor: '#c62828',
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
  },
  escalaDesligarConfirmCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fffbf7',
    borderRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(123, 66, 40, 0.22)',
    zIndex: 1,
    shadowColor: '#2c1810',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  escalaDesligarConfirmIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(141, 62, 50, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    alignSelf: 'center',
  },
  escalaDesligarConfirmTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#3d1f12',
    textAlign: 'center',
    marginBottom: 10,
  },
  escalaDesligarConfirmMessage: {
    fontSize: 15,
    lineHeight: 22,
    color: '#5f4333',
    textAlign: 'center',
  },
  escalaDesligarConfirmActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
  },
  escalaDesligarConfirmBtnSecondary: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1e5dc',
    borderWidth: 1,
    borderColor: 'rgba(123, 66, 40, 0.25)',
  },
  escalaDesligarConfirmBtnSecondaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#5f4333',
  },
  escalaDesligarConfirmBtnDanger: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8d3e32',
    borderWidth: 1,
    borderColor: '#6b2e26',
  },
  escalaDesligarConfirmBtnDangerText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#fff',
  },
  pontoDiaJustObrigConfirmCard: {
    width: '100%',
    maxWidth: 392,
    backgroundColor: '#fffbf7',
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(107, 68, 40, 0.2)',
    zIndex: 1,
    shadowColor: '#2c1810',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  pontoDiaJustObrigIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: 'rgba(138, 90, 43, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(138, 90, 43, 0.2)',
  },
  pontoDiaJustObrigTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#3d2918',
    textAlign: 'center',
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  pontoDiaJustObrigSubtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: '#5f4333',
    textAlign: 'center',
    marginBottom: 14,
  },
  pontoDiaJustObrigEm: {
    fontWeight: '800',
    color: '#6a4428',
  },
  pontoDiaJustObrigBullets: {
    backgroundColor: 'rgba(107, 75, 57, 0.07)',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(107, 75, 57, 0.14)',
  },
  pontoDiaJustObrigBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 11,
  },
  pontoDiaJustObrigBulletRowLast: {
    marginBottom: 0,
  },
  pontoDiaJustObrigBulletDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#8b5a2b',
    marginTop: 7,
    marginRight: 10,
  },
  pontoDiaJustObrigBulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: '#4a3829',
  },
  pontoDiaJustObrigActions: {
    gap: 10,
  },
  pontoDiaJustObrigBtnPrimary: {
    backgroundColor: '#6a4b39',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#5a3d2e',
    shadowColor: '#3d2918',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  pontoDiaJustObrigBtnPrimaryText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },
  pontoDiaJustObrigBtnGhost: {
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(141, 62, 50, 0.38)',
    backgroundColor: 'rgba(255, 251, 247, 0.95)',
  },
  pontoDiaJustObrigBtnGhostText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#8d3e32',
  },
  escalaEmptyText: {
    textAlign: 'center',
    color: '#7a6a5e',
    marginTop: 24,
    paddingHorizontal: 16,
    fontSize: 15,
  },
  escalaCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.18)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  escalaCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  escalaNome: {
    fontSize: 16,
    fontWeight: '700',
    color: '#3d2918',
  },
  escalaCargo: {
    fontSize: 13,
    color: '#6b5344',
    marginTop: 2,
  },
  escalaStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    marginLeft: 8,
  },
  statusPillVerde: {
    backgroundColor: 'rgba(46,125,74,0.18)',
  },
  statusPillVermelho: {
    backgroundColor: 'rgba(198,40,40,0.16)',
  },
  escalaStatusPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#3d2918',
  },
  escalaCalLegendWrap: {
    marginBottom: 8,
  },
  escalaCalLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  escalaCalLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  escalaCalLegendDotVerde: {
    backgroundColor: 'rgba(46,125,74,0.85)',
  },
  escalaCalLegendDotVermelho: {
    backgroundColor: 'rgba(198,40,40,0.85)',
  },
  escalaCalLegendText: {
    fontSize: 12,
    color: '#5f4333',
    fontWeight: '600',
  },
  escalaCalLegendHint: {
    fontSize: 12,
    color: '#8a7a6c',
    marginTop: 4,
    lineHeight: 17,
  },
  presencaWeekHeader: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  presencaWeekHeadCell: {
    flex: 1,
    textAlign: 'center',
    fontSize: 9,
    fontWeight: '600',
    color: '#8a7a6c',
  },
  presencaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  /** Gutter mínimo entre os quadrados (padding no slot, mantém 7×14,28% na grade). */
  presencaDayCellWrap: {
    width: '14.28%',
    padding: 2,
  },
  presencaDayCell: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
    position: 'relative',
    overflow: 'hidden',
  },
  presencaDayCellEmptyFill: {
    width: '100%',
    aspectRatio: 1,
  },
  presencaDayVerde: {
    backgroundColor: 'rgba(46,125,74,0.55)',
  },
  presencaDayVermelho: {
    backgroundColor: 'rgba(198,40,40,0.45)',
  },
  presencaDayNeutro: {
    backgroundColor: '#ece8e4',
  },
  presencaDayNum: {
    fontSize: 11,
    fontWeight: '600',
    color: '#2c241b',
  },
  presencaDayDetMark: {
    position: 'absolute',
    bottom: 3,
    alignSelf: 'center',
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#3d2918',
  },
  /** Letra J à esquerda; F à direita quando ambos no mesmo dia. */
  presencaDayBadgeJ: {
    position: 'absolute',
    bottom: 2,
    left: 6,
    fontSize: 9,
    fontWeight: '600',
    color: '#3d2918',
  },
  presencaDayBadgeF: {
    position: 'absolute',
    bottom: 2,
    right: 4,
    fontSize: 9,
    fontWeight: '600',
    color: '#3d2918',
  },
  presencaDaySwipeActionFolga: {
    flex: 1,
    minWidth: 32,
    marginRight: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(180, 160, 130, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  presencaDaySwipeActionJust: {
    flex: 1,
    minWidth: 32,
    marginLeft: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(100, 130, 165, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  presencaDaySwipeActionText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#2c241b',
  },
  pontoDiaModalScroll: {
    flex: 1,
  },
  pontoDiaModalDataTitulo: {
    fontSize: 17,
    fontWeight: '700',
    color: '#5f4333',
    marginBottom: 16,
    textTransform: 'capitalize',
  },
  pontoDiaModalLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#5f4333',
    marginBottom: 8,
    marginTop: 4,
  },
  pontoDiaModalSimNaoRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  pontoDiaModalChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: '#e8e2dc',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.25)',
  },
  pontoDiaModalChipOn: {
    backgroundColor: '#6a4b39',
    borderColor: '#6a4b39',
  },
  pontoDiaModalChipOnSim: {
    backgroundColor: '#2e7d4a',
    borderColor: '#2e7d4a',
  },
  pontoDiaModalChipLocked: {
    opacity: 0.45,
  },
  pontoDiaModalChipText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#5f4333',
  },
  pontoDiaModalChipTextOn: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  pontoDiaModalJustInput: {
    minHeight: 100,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.35)',
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: '#3d2918',
    textAlignVertical: 'top',
    marginBottom: 16,
    backgroundColor: '#fff',
  },
  pontoDiaModalJustInputLocked: {
    opacity: 0.55,
    backgroundColor: '#f2ebe4',
  },
  pontoDiaModalJustInputObrigatorio: {
    borderWidth: 2,
    borderColor: '#8b5a2b',
    backgroundColor: '#fffaf5',
  },
  pontoDiaModalJustObrigHint: {
    fontSize: 13,
    color: '#6b4f3a',
    marginBottom: 10,
    lineHeight: 19,
    fontWeight: '600',
  },
  pontoDiaModalLabelObrig: {
    fontWeight: '800',
    color: '#8b4513',
  },
  pontoDiaModalFotoHint: {
    fontSize: 13,
    color: '#7a6a5f',
    marginBottom: 8,
    lineHeight: 18,
  },
  pontoDiaModalFotoHintMuted: {
    fontSize: 13,
    color: '#9a8a7f',
    fontStyle: 'italic',
    marginBottom: 10,
  },
  pontoDiaModalAtestPreview: {
    width: '100%',
    height: 200,
    backgroundColor: '#f5f1ec',
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.25)',
  },
  atestadoFullscreenSafe: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  atestadoFullscreenHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  atestadoFullscreenCloseHit: {
    padding: 10,
  },
  atestadoFullscreenImageWrap: {
    flex: 1,
  },
  pontoDiaModalFotoBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
    alignItems: 'center',
  },
  pontoDiaModalFotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#e8e2dc',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,98,82,0.25)',
  },
  pontoDiaModalFotoBtnDanger: {
    backgroundColor: '#f5e8e6',
    borderColor: 'rgba(139,58,42,0.35)',
  },
  pontoDiaModalFotoBtnDisabled: {
    opacity: 0.55,
  },
  pontoDiaModalFotoBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#5f4333',
  },
  pontoDiaModalFotoBtnTextDanger: {
    fontSize: 14,
    fontWeight: '700',
    color: '#8b3a2a',
  },
  header: {
    alignItems: 'center',
    paddingTop: 8,
  },
  profileScroll: {
    flex: 1,
  },
  homeRefreshScroll: {
    flex: 1,
  },
  homeRefreshScrollContent: {},
  homeSectionTitle: {
    fontSize: 22,
    fontWeight: '500',
    color: '#3d1f12',
    marginTop: 22,
    marginBottom: 10,
    paddingHorizontal: 2,
    letterSpacing: 0.3,
  },
  homeSectionCard: {
    marginTop: 4,
  },
  factoryCardWrap: {
    width: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    marginTop: 4,
  },
  factoryCard: {
    height: 220,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 18,
    backgroundColor: '#3d2818',
  },
  factoryCardDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(30, 20, 14, 0.28)',
  },
  factoryCardHint: {
    fontSize: 34,
    color: '#fff',
    fontWeight: '800',
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0, 0, 0, 0.55)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
    zIndex: 1,
  },
  profileScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  profileScrollContentDashboard: {
    justifyContent: 'flex-start',
    paddingTop: 16,
  },
  profileTitle: {
    fontSize: 34,
    color: '#3d1f12',
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  profileSubtitle: {
    fontSize: 16,
    color: '#7a6252',
    textAlign: 'center',
    marginBottom: 18,
  },
  loginCard: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.14)',
  },
  input: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d9c8ba',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    color: '#3d1f12',
    marginBottom: 10,
    fontSize: 15,
  },
  inputError: {
    borderColor: '#d95a5a',
    borderWidth: 1.5,
  },
  fieldErrorText: {
    marginTop: -4,
    marginBottom: 8,
    marginLeft: 2,
    fontSize: 12,
    color: '#d95a5a',
    fontWeight: '600',
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d9c8ba',
    backgroundColor: '#fff',
    marginBottom: 10,
    paddingRight: 2,
    overflow: 'visible',
  },
  passwordRowError: {
    borderColor: '#d95a5a',
    borderWidth: 1.5,
  },
  passwordInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    paddingHorizontal: 14,
    paddingRight: 8,
    color: '#3d1f12',
    fontSize: 15,
  },
  eyeButton: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  registerBlock: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(122,98,82,0.2)',
  },
  /** Cadastro completo (sem botão Entrar no meio): ligação visual com e-mail/senha. */
  registerBlockCadastroFluxo: {
    marginTop: 12,
    paddingTop: 14,
  },
  primaryButton: {
    marginTop: 4,
    height: 46,
    borderRadius: 12,
    backgroundColor: '#7b4228',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  textButton: {
    marginTop: 10,
    alignItems: 'center',
  },
  textButtonLabel: {
    color: '#6e4d39',
    fontWeight: '600',
  },
  googleButton: {
    marginTop: 14,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d9c8ba',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  googleButtonText: {
    color: '#5f4333',
    fontWeight: '700',
    fontSize: 14,
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  authHint: {
    fontSize: 12,
    color: '#8b735f',
    marginBottom: 8,
    lineHeight: 16,
  },
  loggedCard: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.14)',
    alignItems: 'center',
  },
  loggedTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#3d1f12',
    marginBottom: 20,
    textAlign: 'center',
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#7b4228',
  },
  secondaryButtonText: {
    color: '#7b4228',
    fontWeight: '700',
  },
  profileAwaitingModalFill: {
    flexGrow: 1,
    minHeight: 320,
  },
  profileDashboard: {
    alignSelf: 'center',
    paddingBottom: 110,
  },
  profileBrownHeader: {
    width: '100%',
    backgroundColor: '#7b4228',
    paddingHorizontal: 16,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  profileBrownHeaderTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'right',
  },
  profileAvatarBlock: {
    alignItems: 'center',
    paddingTop: 22,
    paddingBottom: 6,
  },
  /** Página Perfil (logado): espaço extra no topo para não cortar foto / ícone da câmera. */
  profilePageAvatarBlock: {
    alignItems: 'center',
    paddingTop: 22,
    paddingBottom: 8,
  },
  profilePageAvatarCircle: {
    width: 108,
    height: 108,
    borderRadius: 54,
    overflow: 'visible',
    backgroundColor: '#e8ddd4',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  profilePageAvatarImageMask: {
    width: '100%',
    height: '100%',
    borderRadius: 54,
    overflow: 'hidden',
  },
  profilePageAvatarEditBtn: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#7b4228',
    borderWidth: 1,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 2,
  },
  profilePageMenuCard: {
    marginHorizontal: 22,
    marginTop: 14,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.14)',
    overflow: 'hidden',
  },
  homeProfileAvatarBlock: {
    alignItems: 'center',
    paddingTop: 2,
    paddingBottom: 6,
  },
  profileAvatarCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    overflow: 'visible',
    backgroundColor: '#e8ddd4',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  profileAvatarImage: {
    width: '100%',
    height: '100%',
  },
  profileAvatarImageMask: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
    overflow: 'hidden',
  },
  profileAvatarEditBtn: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#7b4228',
    borderWidth: 1,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 2,
  },
  profileMenuCard: {
    marginHorizontal: 22,
    marginTop: 12,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(122,98,82,0.14)',
    overflow: 'hidden',
  },
  profileMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(122,98,82,0.18)',
  },
  profileMenuRowDisabled: {
    opacity: 0.46,
  },
  profileMenuRowBeforeDanger: {
    borderBottomWidth: 0,
  },
  profileMenuRowLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3d1f12',
  },
  profileMenuRowLabelDisabled: {
    color: '#8f8178',
  },
  profileMenuRowDangerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(122,98,82,0.22)',
  },
  profileMenuRowDanger: {
    fontSize: 16,
    fontWeight: '600',
    color: '#b85c4a',
  },
  profileSairBtn: {
    marginTop: 22,
    alignSelf: 'center',
  },
  welcomeModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  welcomeModalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingVertical: 26,
    paddingHorizontal: 22,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  welcomeModalTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#3d1f12',
    textAlign: 'center',
    marginBottom: 12,
  },
  /** Logo do app no cartão branco de retorno (tamanho discreto). */
  welcomeModalAppIcon: {
    width: 72,
    height: 72,
    borderRadius: 16,
    alignSelf: 'center',
    marginBottom: 18,
    borderWidth: 2,
    borderColor: 'rgba(61,31,18,0.12)',
  },
  /** "Feliz hoje!" em destaque abaixo do ícone. */
  welcomeModalFelizBig: {
    fontSize: 34,
    fontWeight: '800',
    color: '#3d1f12',
    textAlign: 'center',
    letterSpacing: 0.3,
    marginBottom: 14,
  },
  welcomeModalMessage: {
    fontSize: 16,
    fontWeight: '500',
    color: '#6a4b39',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  welcomeModalOk: {
    backgroundColor: '#7b4228',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeModalOkText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  profileEditBackdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  profileEditBackdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  profileEditCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fffbf7',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(123, 66, 40, 0.2)',
    zIndex: 1,
  },
  photoPickerCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fffbf7',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(123, 66, 40, 0.2)',
    zIndex: 1,
  },
  photoPickerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#3d1f12',
    marginBottom: 8,
  },
  photoPickerOption: {
    height: 44,
    borderRadius: 10,
    backgroundColor: 'rgba(123,66,40,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  photoPickerOptionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#5f4333',
  },
  photoPreviewCard: {
    width: '88%',
    maxWidth: 420,
    aspectRatio: 1,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    zIndex: 1,
  },
  photoPreviewImage: {
    width: '100%',
    height: '100%',
  },
  profileEditTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#3d1f12',
    marginBottom: 12,
  },
  profileEditActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  profileActionBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileActionBtnPrimary: {
    backgroundColor: '#7b4228',
    borderWidth: 1,
    borderColor: '#5f2f1d',
  },
  profileActionBtnSecondary: {
    backgroundColor: '#f1e5dc',
    borderWidth: 1,
    borderColor: '#d8c2b2',
  },
  profileActionBtnPrimaryText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.2,
  },
  profileActionBtnSecondaryText: {
    color: '#7a6252',
    fontWeight: '700',
    fontSize: 14,
  },
  profileEditCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  profileEditCancelText: {
    color: '#7a6252',
    fontWeight: '700',
  },
  profileEditSaveBtn: {
    marginTop: 0,
    minWidth: 110,
    paddingHorizontal: 14,
  },
  profileChocolateButton: {
    marginTop: 8,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#7b4228',
    borderWidth: 1,
    borderColor: '#5f2f1d',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3d1f12',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  profileChocolateButtonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.3,
  },
});

const extraGoogle = Constants.expoConfig?.extra as
  | {
      googleAndroidClientId?: string;
      googleWebClientId?: string;
      googleIosClientId?: string;
    }
  | undefined;
const G_ANDROID = (extraGoogle?.googleAndroidClientId ?? '').trim();
const G_IOS = (extraGoogle?.googleIosClientId ?? '').trim();
const G_WEB = (extraGoogle?.googleWebClientId ?? '').trim();
/** Web obrigatório; Android precisa do client nativo; iOS precisa do client iOS (bundle id no Google Cloud). */
const googleConfigured =
  G_WEB.length > 0 &&
  (Platform.OS === 'android' ? G_ANDROID.length > 0 : Platform.OS === 'ios' ? G_IOS.length > 0 : false);

function AppWithGoogle() {
  const [_request, response, promptAsync] = Google.useIdTokenAuthRequest({
    androidClientId: G_ANDROID,
    iosClientId: G_IOS || undefined,
    webClientId: G_WEB,
    scopes: ['openid', 'profile', 'email'],
    selectAccount: true,
  });

  return (
    <AppInner
      googleAuth={{
        response,
        promptAsync,
      }}
    />
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {googleConfigured ? <AppWithGoogle /> : <AppInner googleAuth={null} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

