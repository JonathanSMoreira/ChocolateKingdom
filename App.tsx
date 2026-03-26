import { StatusBar } from 'expo-status-bar';
import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { BlurView } from 'expo-blur';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import type { AuthSessionResult } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

WebBrowser.maybeCompleteAuthSession();

function apiBaseUrl(): string {
  const fromExtra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (fromExtra && typeof fromExtra === 'string' && fromExtra.length > 0) {
    return fromExtra.replace(/\/$/, '');
  }
  if (__DEV__ && Platform.OS === 'android') {
    return 'http://10.0.2.2:3000';
  }
  return __DEV__ ? 'http://localhost:3000' : 'http://localhost:3000';
}

/** Sem isso o fetch pode ficar minutos esperando se o servidor não responder (ex.: backend parado). */
const API_FETCH_TIMEOUT_MS = 15000;
const PHOTO_UPLOAD_TIMEOUT_MS = 60000;
const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = API_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
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

function mapLocalFallbackImageUrl(local: Pick<MapLocal, 'codigo' | 'tipo'>): string | null {
  switch (local.codigo) {
    case 'banheiro-topo':
      return 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80';
    case 'restaurante-direita':
      return 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80';
    case 'lanchonete-meio':
      return 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=1000&q=80';
    case 'montanha-russa-encantada':
      return 'https://upload.wikimedia.org/wikipedia/commons/3/3d/Kingda_Ka.jpg';
    case 'pkaleo':
      return 'https://images.unsplash.com/photo-1520975661595-6453be3f7070?auto=format&fit=crop&w=1000&q=80';
    case 'cacau-show':
      return 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chocolate_%28blue_background%29.jpg';
    default:
      return local.tipo === 'banheiro'
        ? 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
        : null;
  }
}

function mapLocalImageCandidates(local: Pick<MapLocal, 'codigo' | 'tipo' | 'imagemUrl'>): string[] {
  const list: string[] = [];
  const pushIfValid = (value?: string | null) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.length > 0 && !list.includes(v)) list.push(v);
  };
  pushIfValid(local.imagemUrl);
  pushIfValid(mapLocalFallbackImageUrl(local));
  if (local.tipo === 'banheiro') {
    pushIfValid(
      'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1000&q=80'
    );
  } else if (local.tipo === 'restaurante' || local.tipo === 'lanchonete') {
    pushIfValid(
      'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1000&q=80'
    );
  } else {
    pushIfValid('https://upload.wikimedia.org/wikipedia/commons/3/3d/Kingda_Ka.jpg');
  }
  return list;
}

const MAP_LEGEND_ROWS: { key: MapHotspotCategoria; title: string; subtitle: string }[] = [
  { key: 'banheiro', title: 'Banheiros', subtitle: 'WC e espaços de apoio' },
  { key: 'comida', title: 'Comida e bebidas', subtitle: 'Restaurantes e lanchonetes' },
  { key: 'diversao', title: 'Diversão', subtitle: 'Atrações e shows' },
];

/** Tamanho único do círculo do ícone no mapa (legenda usa o mesmo valor para manter consistência). */
const MAP_HOTSPOT_MARK_SIZE = 40;

/** Borda pulsante por categoria — cores discretas (opacidade animada em separado). */
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

/** Zoom do PNG dentro do círculo: diversão com um pouco mais de crop para esconder borda clara. */
function mapHotspotIconInsetScale(cat: MapHotspotCategoria): number {
  return cat === 'diversao' ? 1.24 : 1.1;
}

// Hotspots quando a API está indisponível — mesmas caixas que `mapa_locais_schema.sql`
// (malha 1024×1024, origem inferior esquerda na arte → X/Y normalizados canto sup. esq. no app).
const MAP_LOCAIS_DEMO: MapLocal[] = [
  {
    codigo: 'banheiro-topo',
    nome: 'Banheiro',
    tipo: 'banheiro',
    categoria: 'Banheiro',
    descricao: 'Higiene e fraldário.',
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
    descricao: 'Lanches rápidos e bebidas.',
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
    categoria: 'Diversão',
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
    categoria: 'Diversão',
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
    categoria: 'Diversão',
    descricao: 'Show e experiências.',
    classificacao: 'Adulto',
    alturaMinCm: 140,
    aberto: false,
    tempoFilaMin: null,
    imagemUrl:
      'https://upload.wikimedia.org/wikipedia/commons/7/70/Chocolate_%28blue_background%29.jpg',
    x: 0.765547,
    y: 0.379063,
    w: 0.12,
    h: 0.09,
  },
];

function AppInner({ googleAuth }: AppInnerProps) {
  const insets = useSafeAreaInsets();
  const [activeSlide, setActiveSlide] = useState(0);
  const [activeTab, setActiveTab] = useState<'home' | 'ingressos' | 'mapa' | 'perfil'>('home');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
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
  const cardWidth = screenWidth - 44;
  const cocoaPattern = require('./assets/bg-cacau-pattern.png');
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
      title: 'Atrações',
      image: atracoesBackground,
      openMapCategory: 'diversao',
    },
  ];

  const handleSlideChange = (offsetX: number) => {
    const index = Math.round(offsetX / cardWidth);
    setActiveSlide(index);
  };
  const showBottomNav = !showRegisterForm;

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

  const buildImageDataUri = async (asset: {
    uri: string;
    base64?: string | null;
    mimeType?: string | null;
  }): Promise<string> => {
    const mime = asset.mimeType || 'image/jpeg';
    if (asset.base64 && asset.base64.length > 0) {
      return `data:${mime};base64,${asset.base64}`;
    }
    const b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
      encoding: FileSystemLegacy.EncodingType.Base64,
    });
    return `data:${mime};base64,${b64}`;
  };

  const uploadProfilePhoto = async (photoDataUri: string): Promise<string | null> => {
    if (!currentClienteId) return null;
    const sizeBytes = estimateDataUriBytes(photoDataUri);
    if (sizeBytes > MAX_PROFILE_PHOTO_BYTES) {
      Alert.alert('Foto', 'A imagem está muito grande. Escolha uma foto menor (até 10MB).');
      return null;
    }
    try {
      const base = apiBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/clientes/${currentClienteId}/foto`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fotoPerfil: photoDataUri }),
      }, PHOTO_UPLOAD_TIMEOUT_MS);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 413) {
          Alert.alert('Foto', 'A imagem está muito grande. Escolha uma foto menor (até 10MB).');
          return null;
        }
        const detail = typeof data?.detail === 'string' ? `\n${data.detail}` : '';
        Alert.alert('Foto', `${data.error || `Erro ${res.status}`}${detail}`);
        return null;
      }
      const foto = typeof data?.cliente?.fotoPerfil === 'string' ? data.cliente.fotoPerfil : '';
      return foto || null;
    } catch {
      Alert.alert('Foto', 'Não foi possível salvar a foto no servidor.');
      return null;
    }
  };

  const pickProfilePhotoFromCamera = async () => {
    setPhotoPickerVisible(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Foto', 'Permita acesso à câmera para tirar a foto.');
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
        const dataUri = await buildImageDataUri(asset);
        const savedPhoto = await uploadProfilePhoto(dataUri);
        if (savedPhoto) setProfilePhotoUri(savedPhoto);
      } catch {
        Alert.alert('Foto', 'A foto foi selecionada, mas não foi possível gravar no banco.');
      }
    }
  };

  const pickProfilePhotoFromGallery = async () => {
    setPhotoPickerVisible(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Foto', 'Permita acesso à galeria para selecionar a foto.');
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
        const dataUri = await buildImageDataUri(asset);
        const savedPhoto = await uploadProfilePhoto(dataUri);
        if (savedPhoto) setProfilePhotoUri(savedPhoto);
      } catch {
        Alert.alert('Foto', 'A foto foi selecionada, mas não foi possível gravar no banco.');
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
      const b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      const mime = asset.mimeType || 'image/jpeg';
      const dataUri = `data:${mime};base64,${b64}`;
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
    setProfileSaving(true);
    try {
      const base = apiBaseUrl();
      const payload = {
        id: currentClienteId,
        email: profileEmail || email,
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
      setProfileModalVisible(false);
      Alert.alert('Perfil', 'Informações pessoais salvas com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const saveContactInfo = async () => {
    if (!currentClienteId) {
      Alert.alert('Contato', 'Conta não identificada. Entre novamente.');
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
      Alert.alert('Contato', 'Informações de contato salvas com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const savePasswordInfo = async () => {
    if (!currentClienteId) {
      Alert.alert('Senha', 'Conta não identificada. Entre novamente.');
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
        'Mínimo 8 caracteres: maiúscula, minúscula, número e caractere especial.'
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
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível salvar agora.'
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
      Alert.alert('Endereço', 'Conta não identificada. Entre novamente.');
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
        Alert.alert('Endereço', data.error || `Erro ${res.status}`);
        return;
      }
      setAddressModalVisible(false);
      Alert.alert('Endereço', 'Endereço salvo com sucesso.');
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível salvar agora.'
      );
    } finally {
      setProfileSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!currentClienteId) {
      Alert.alert('Conta', 'Conta não identificada. Entre novamente.');
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
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Não foi possível excluir a conta agora.'
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: mail, password: pwd }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        Alert.alert('Cadastro', 'E-mail não existe');
        setShowRegisterForm(true);
        return;
      }
      if (res.status === 400) {
        Alert.alert('E-mail', data.error || 'E-mail incorreto');
        return;
      }
      if (res.status === 401) {
        Alert.alert('Senha', 'Senha incorreta');
        return;
      }
      if (!res.ok) {
        Alert.alert('Login', data.error || `Erro ${res.status}`);
        return;
      }
      const apelidoLogin =
        typeof data.cliente?.apelido === 'string'
          ? data.cliente.apelido.trim()
          : typeof data.cliente?.nome === 'string'
            ? data.cliente.nome.trim()
            : '';
      setUserNome(apelidoLogin);
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
      setProfileEmail(typeof data.cliente?.email === 'string' ? data.cliente.email : mail);
      setTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : '');
      setLoggedInAsReturning(true);
      setIsLoggedIn(true);
      setShowRegisterForm(false);
      setPassword('');
      setNomeCompleto('');
      setDataNascimento('');
      setTelefone('');
      setCpf('');
      setWelcomeReturnModalVisible(true);
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted
          ? `O servidor não respondeu em ${API_FETCH_TIMEOUT_MS / 1000}s. Confira se o backend está rodando (npm start na pasta backend) e se o endereço está certo (${apiBaseUrl()} no Android emulador = PC na porta 3000).`
          : 'Não foi possível falar com o servidor. Verifique o backend e a rede.'
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
      nextErrors.password = 'Mínimo 8 caracteres: maiúscula, minúscula, número e especial.';
    }
    if (nomeCompleto.trim().length < 2) {
      nextErrors.nomeCompleto = 'Informe como quer ser chamado (mínimo 2 caracteres).';
    }
    const dataNascimentoIso = parseDataNascimentoBrToIso(dataNascimento);
    if (!dataNascimentoIso) {
      nextErrors.dataNascimento =
        'Informe a data completa: dia, mês e ano (DD/MM/AAAA).';
    }

    const cpfDigits = cpf.replace(/\D/g, '');
    if (cpfDigits.length > 0 && (cpfDigits.length !== 11 || !isCpfValid(cpfDigits))) {
      nextErrors.cpf = 'Informe os 11 dígitos de um CPF válido ou deixe em branco.';
    }

    if (Object.keys(nextErrors).length > 0) {
      setRegisterErrors(nextErrors);
      Alert.alert('Cadastro', 'Existem campos inválidos. Corrija os campos em vermelho.');
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
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted
          ? 'Servidor não respondeu a tempo. Inicie o backend e tente de novo.'
          : 'Não foi possível concluir o cadastro.'
      );
    } finally {
      setAuthBusy(false);
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
        Alert.alert('Google', data.error || `Erro ${res.status}`);
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
      setProfileEmail(typeof data.cliente?.email === 'string' ? data.cliente.email : email);
      setTelefone(typeof data.cliente?.telefone === 'string' ? data.cliente.telefone : '');
      setLoggedInAsReturning(!data.criado);
      setIsLoggedIn(true);
      if (data.criado) {
        Alert.alert('Conta criada com Google', 'Seus dados foram salvos. Bem-vindo!');
      } else {
        setWelcomeReturnModalVisible(true);
      }
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      Alert.alert(
        aborted ? 'Tempo esgotado' : 'Conexão',
        aborted ? 'Servidor não respondeu a tempo.' : 'Falha ao enviar o token para o servidor.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    const r = googleAuth?.response;
    if (!r || r.type !== 'success') return;

    const idToken =
      r.authentication?.idToken ??
      (typeof r.params?.id_token === 'string' ? r.params.id_token : '');

    if (idToken) {
      void sendGoogleIdToken(idToken);
    } else {
      Alert.alert('Google', 'Não recebemos o id_token. Verifique os Client IDs no app.json (extra).');
    }
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
        'Configure googleAndroidClientId e googleWebClientId em app.json → expo.extra (mesmo projeto do Google Cloud).'
      );
      return;
    }
    setAuthBusy(true);
    try {
      await googleAuth.promptAsync();
    } finally {
      setAuthBusy(false);
    }
  };

  const mapBottomReserve = 76 + Math.max(insets.bottom, 10);
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

    // Centraliza um pouco acima do meio para não ficar por baixo da "sheet" de informações.
    const focusCenterY = mapViewportHeight * 0.42;

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
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
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
                      marginTop: -(22 + insets.top) + 30,
                    },
                  ]}
                >
                  <View style={styles.profileAvatarBlock}>
                    <View style={styles.profileAvatarCircle}>
                      <TouchableOpacity
                        style={styles.profileAvatarImageMask}
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
                        style={styles.profileAvatarEditBtn}
                        onPress={openProfilePhotoPicker}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel="Editar foto de perfil"
                      >
                        <Feather name="camera" size={14} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <View style={styles.profileMenuCard}>
                    {[
                      { label: 'Informações pessoais', onPress: () => setProfileModalVisible(true) },
                      {
                        label: 'Informações de contato',
                        onPress: () => {
                          if (!profileTelefone && telefone) setProfileTelefone(telefone);
                          if (!profileEmail && email) setProfileEmail(email);
                          setContactModalVisible(true);
                        },
                      },
                      { label: 'Senha', onPress: () => setPasswordModalVisible(true) },
                      {
                        label: 'Endereço',
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
                      setAddressRua('');
                      setAddressBairro('');
                      setAddressPais('');
                      setAddressCep('');
                      setAddressNumero('');
                      setShowRegisterForm(false);
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
                      setAddressRua('');
                      setAddressBairro('');
                      setAddressPais('');
                      setAddressCep('');
                      setAddressNumero('');
                      setShowRegisterForm(false);
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
                  Senha de 8+ caracteres: Maiúscula, minúscula, número e especial.
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

                  {(mapLocais.length ? mapLocais : MAP_LOCAIS_DEMO).map((local) => {
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
                        Classificação: {selectedMapLocal.classificacao}
                      </Text>
                    ) : null}
                    {selectedMapLocal.alturaMinCm != null ? (
                      <Text style={styles.mapInfoDetailLine}>
                        Altura mínima: {selectedMapLocal.alturaMinCm} cm
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
                    <Text style={styles.mapInfoCloseText}>✕</Text>
                  </TouchableOpacity>
                </View>

                {mapInfoImageUri ? (
                  <Image
                    source={{
                      uri: mapInfoImageUri,
                    }}
                    style={styles.mapInfoAttractionImage}
                    resizeMode="cover"
                    onError={() => {
                      setMapInfoImageAttempt((prev) =>
                        prev + 1 < mapInfoImageCandidates.length ? prev + 1 : prev
                      );
                    }}
                  />
                ) : null}
              </View>
              ) : null}
              </View>
            </View>
        ) : (
          <ScrollView
            style={styles.homeRefreshScroll}
            contentContainerStyle={styles.homeRefreshScrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={isRefreshing} onRefresh={() => void handlePullRefresh()} />
            }
          >
            <View style={styles.header}>
              <Text style={styles.brandTitle}>Cacau Show</Text>
              <Text style={styles.subtitle}>
                Bem-vindo ao mundo onde o chocolate e a diversão se conectam.
              </Text>
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
              <View style={styles.iconBubble}>
                <Ionicons name="person-outline" size={21} color="#6a4b39" />
              </View>
              <Text style={styles.navLabel}>Perfil</Text>
            </TouchableOpacity>
          </View>
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
            accessibilityLabel="Fechar informações pessoais"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Informações pessoais</Text>
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
            accessibilityLabel="Fechar visualização da foto"
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
            accessibilityLabel="Fechar seleção de foto"
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
            accessibilityLabel="Fechar informações de contato"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Informações de contato</Text>
            <TextInput
              value={profileTelefone}
              onChangeText={setProfileTelefone}
              placeholder="Número de telefone"
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
              Senha de 8+ caracteres: Maiúscula, minúscula, número e especial.
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
            accessibilityLabel="Fechar tela de endereço"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Endereço</Text>
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
              placeholder="País"
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
              placeholder="Número"
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
            accessibilityLabel="Fechar confirmação de exclusão"
          />
          <View style={styles.profileEditCard}>
            <Text style={styles.profileEditTitle}>Excluir conta</Text>
            <Text style={styles.welcomeModalMessage}>
              Tem certeza que deseja excluir sua conta? Esta ação é permanente.
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
            <Text style={styles.welcomeModalTitle}>Conta excluída</Text>
            <Text style={styles.welcomeModalMessage}>
              Ficamos tristes com essa decisão, mas nos encontraremos em breve!
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
            <Text style={styles.welcomeModalTitle}>Feliz hoje!</Text>
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
          <View style={[styles.mapLegendCard, { maxHeight: screenHeight * 0.76 }]}>
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
                <Text style={styles.mapLegendCloseBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.mapLegendHint}>
              Toque num tipo de ícone para ver os locais carregados no mapa.
            </Text>
            <ScrollView
              style={styles.mapLegendScroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {MAP_LEGEND_ROWS.map((row) => {
                const locaisAtuais = mapLocais.length ? mapLocais : MAP_LOCAIS_DEMO;
                const itens = locaisDaCategoria(locaisAtuais, row.key);
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
                          itens.map((local) => (
                            <TouchableOpacity
                              key={local.codigo}
                              style={styles.mapLegendListItem}
                              activeOpacity={0.85}
                              onPress={() => {
                                setMapLegendVisible(false);
                                setMapLegendOpenCategory(null);
                                setSelectedMapLocal(local);
                                zoomToLocal(local);
                              }}
                            >
                              <View style={styles.mapLegendListItemRow}>
                                <Text style={styles.mapLegendListItemText}>{local.nome}</Text>
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
                            </TouchableOpacity>
                          ))
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

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f6f4f2',
  },
  container: {
    flex: 1,
    backgroundColor: '#f6f4f2',
    paddingHorizontal: 22,
    paddingTop: 22,
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
    fontWeight: '300',
  },
  mapLegendHint: {
    fontSize: 13,
    color: '#8b735f',
    marginBottom: 8,
    lineHeight: 18,
  },
  mapLegendScroll: {
    maxHeight: 440,
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
    fontSize: 15,
    color: '#5c3d2e',
    fontWeight: '600',
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
    bottom: 0,
    left: -22,
    right: -22,
    minHeight: 68,
    paddingTop: 8,
    paddingHorizontal: 6,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
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
  homeRefreshScrollContent: {
    paddingBottom: 6,
  },
  profileScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  profileScrollContentDashboard: {
    justifyContent: 'flex-start',
    paddingTop: 0,
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
  profileMenuRowBeforeDanger: {
    borderBottomWidth: 0,
  },
  profileMenuRowLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#3d1f12',
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
  | { googleAndroidClientId?: string; googleWebClientId?: string }
  | undefined;
const G_ANDROID = (extraGoogle?.googleAndroidClientId ?? '').trim();
const G_WEB = (extraGoogle?.googleWebClientId ?? '').trim();
const googleConfigured = G_ANDROID.length > 0 && G_WEB.length > 0;

function AppWithGoogle() {
  const [_request, response, promptAsync] = Google.useAuthRequest({
    androidClientId: G_ANDROID,
    webClientId: G_WEB,
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
    <SafeAreaProvider>
      {googleConfigured ? <AppWithGoogle /> : <AppInner googleAuth={null} />}
    </SafeAreaProvider>
  );
}
