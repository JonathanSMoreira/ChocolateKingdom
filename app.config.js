/* eslint-disable @typescript-eslint/no-var-requires */
require('dotenv').config();

/**
 * Permite definir a URL da API no momento do build (APK/IP público).
 *
 * Prioridade: EXPO_PUBLIC_API_URL (variável de ambiente) → app.json → extra.apiUrl
 *
 * Exemplos (PowerShell, antes de `eas build` ou `npx expo start`):
 *   $env:EXPO_PUBLIC_API_URL='http://192.168.1.10:3000'; npx eas-cli build --platform android --profile preview
 *
 * Na Expo: Project → Secrets / Environment variables → EXPO_PUBLIC_API_URL (builds na nuvem).
 *
 * Fora da rede local (5G, outro Wi‑Fi): use HTTPS para um servidor acessível na Internet.
 */
const appJson = require('./app.json');

const fromEnv = process.env.EXPO_PUBLIC_API_URL?.trim();
const fallback = appJson.expo?.extra?.apiUrl?.trim() || '';

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...appJson.expo.extra,
      apiUrl: fromEnv && fromEnv.length > 0 ? fromEnv : fallback,
    },
  },
};
