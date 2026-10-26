// Packaging for macOS (docs/22 Phase 8e, docs/DEVELOPMENT.md "Package").
//
// Without signing credentials the app is ad-hoc signed: it runs on this Mac, and Apple Silicon
// needs at least that once the fuses are flipped. With a Developer ID certificate (CSC_LINK +
// CSC_KEY_PASSWORD, or CSC_NAME for one in the keychain) it is signed for distribution, and with
// notarization credentials also notarized and stapled. The credentials come only from the
// environment or the keychain, never from this file.
const env = process.env;

const developerId = Boolean(env.CSC_LINK || env.CSC_NAME);
const notarization = Boolean(
  env.APPLE_KEYCHAIN_PROFILE ||
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID),
);
if (env.TABREACH_RELEASE === '1' && !(developerId && notarization)) {
  // Names only, never values: says which of the expected variables arrived empty.
  const empty = [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
  ].filter((name) => !env[name]);
  throw new Error(
    `TABREACH_RELEASE=1 needs a Developer ID certificate (CSC_LINK or CSC_NAME) and notarization credentials; empty: ${empty.join(', ') || 'none'}`,
  );
}

const entitlements = developerId ? 'build/entitlements.mac.plist' : 'build/entitlements.adhoc.plist';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.tabreach.app',
  productName: 'TabReach',
  copyright: 'Copyright © 2026 TabReach',
  directories: { output: 'release', buildResources: 'build' },
  files: ['out/**', 'package.json'],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    target: [{ target: 'dir', arch: ['arm64'] }],
    // Left unset, electron-builder finds the Developer ID identity (CSC_LINK, or CSC_NAME in the
    // keychain); null would skip signing altogether. '-' is ad-hoc.
    ...(developerId ? {} : { identity: '-' }),
    hardenedRuntime: true,
    // Electron's V8 needs JIT under the hardened runtime; nothing else (docs/18). An ad-hoc build
    // also turns off library validation, without which it cannot load Electron's framework.
    entitlements: entitlements,
    entitlementsInherit: entitlements,
    notarize: developerId && notarization,
  },
  dmg: {
    // The app inside is notarized and stapled by electron-builder; the signed DMG itself is
    // notarized and stapled by the release workflow.
    sign: developerId,
    artifactName: '${productName}-${version}-${arch}.${ext}',
    title: '${productName} ${version}',
  },
  // Electron fuses (docs/18-SECURITY-PRIVACY-COMPLIANCE.md). RunAsNode stays disabled: the Phase 0
  // validation showed utilityProcess works for the browser worker (ADR 012).
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
};
