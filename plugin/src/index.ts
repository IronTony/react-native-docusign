import * as crypto from 'crypto';
import {
  AndroidConfig,
  ConfigPlugin,
  WarningAggregator,
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
  withProjectBuildGradle,
} from 'expo/config-plugins';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CAMERA_PERMISSION =
  'Allows signing DocuSign documents with your camera and capturing signatures.';
const DEFAULT_PHOTO_PERMISSION =
  'Allows selecting photos to attach to DocuSign documents.';

const SDK_PDF_VERSION = '2.1.4';
const SDK_PDF_UPSTREAM_URL = `https://docucdn-a.akamaihd.net/prod/docusignandroidsdk/com/docusign/sdk-pdf/${SDK_PDF_VERSION}/sdk-pdf-${SDK_PDF_VERSION}.aar`;
// SHA-256 of the upstream `sdk-pdf-2.1.4.aar` as published on DocuSign's CDN.
// Verified at the time this version of the plugin was cut. Any deviation
// (CDN tampering, DNS hijack, partial download) causes the plugin to throw
// rather than write a binary we cannot vouch for. To bump the upstream SDK
// version, recompute this hash locally:
//   curl -sSL <SDK_PDF_UPSTREAM_URL> | shasum -a 256
const SDK_PDF_SHA256 =
  '26eb53effd74d117397fbfd77e46a94786bbbd05fb9318fdbbff389c1a4dcb0a';
const STRIPPED_AAR_FILENAME = `sdk-pdf-${SDK_PDF_VERSION}-stripped.aar`;
const GLIDE_GENERATED_CLASS =
  'com/bumptech/glide/GeneratedAppGlideModuleImpl.class';

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isValidAar(filePath: string): boolean {
  // An AAR is a ZIP. Smoke-test the central directory by attempting to enumerate
  // entries and find classes.jar. Catches zero-byte or truncated cache files.
  try {
    const AdmZip = require('adm-zip') as typeof import('adm-zip');
    const zip = new AdmZip(filePath);
    return zip.getEntries().some((e) => e.entryName === 'classes.jar');
  } catch {
    return false;
  }
}

export type DocuSignPluginProps = {
  cameraPermission?: string;
  photoPermission?: string;
  androidMavenRepo?: string;
};

const withDocuSignIos: ConfigPlugin<DocuSignPluginProps> = (config, props) =>
  withInfoPlist(config, (cfg) => {
    cfg.modResults.NSCameraUsageDescription =
      props.cameraPermission ??
      cfg.modResults.NSCameraUsageDescription ??
      DEFAULT_CAMERA_PERMISSION;
    cfg.modResults.NSPhotoLibraryUsageDescription =
      props.photoPermission ??
      cfg.modResults.NSPhotoLibraryUsageDescription ??
      DEFAULT_PHOTO_PERMISSION;
    return cfg;
  });

const withDocuSignAndroidPermissions: ConfigPlugin = (config) => {
  const permissions = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.CAMERA',
  ];

  return withAndroidManifest(config, (cfg) => {
    permissions.forEach((permission) => {
      AndroidConfig.Permissions.addPermission(cfg.modResults, permission);
    });
    return cfg;
  });
};

const withDocuSignAndroidMavenRepo: ConfigPlugin<DocuSignPluginProps> = (
  config,
  props,
) => {
  const repo =
    props.androidMavenRepo ??
    'https://docucdn-a.akamaihd.net/prod/docusignandroidsdk';

  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      WarningAggregator.addWarningAndroid(
        'react-native-docusign',
        `android/build.gradle is Kotlin Script (.kts); cannot auto-inject the DocuSign maven repo. Add the following manually inside allprojects.repositories:\n  maven("${repo}")`,
      );
      return cfg;
    }

    if (cfg.modResults.contents.includes(repo)) {
      return cfg;
    }

    const mavenBlock = `        maven { url "${repo}" }`;
    const allprojectsRepositoriesRegex =
      /(allprojects\s*\{[\s\S]*?repositories\s*\{)/;
    if (allprojectsRepositoriesRegex.test(cfg.modResults.contents)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        allprojectsRepositoriesRegex,
        `$1\n${mavenBlock}`,
      );
    }

    return cfg;
  });
};

const FLAT_DIR_MARKER = 'react-native-docusign-stripped-aar-flatdir';

const withDocuSignAndroidStrippedAarFlatDir: ConfigPlugin = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      WarningAggregator.addWarningAndroid(
        'react-native-docusign',
        'android/build.gradle is Kotlin Script (.kts); cannot auto-inject the stripped sdk-pdf flatDir. Add this inside allprojects:\n  afterEvaluate {\n    rootProject.findProject(":react-native-docusign")?.let { docusignProject ->\n      repositories { flatDir { dirs("${docusignProject.projectDir}/libs") } }\n    }\n  }',
      );
      return cfg;
    }

    if (cfg.modResults.contents.includes(FLAT_DIR_MARKER)) {
      return cfg;
    }

    const flatDirBlock = `  // ${FLAT_DIR_MARKER}: exposes the stripped sdk-pdf AAR bundled with react-native-docusign.
  // The AAR has com.bumptech.glide.GeneratedAppGlideModuleImpl removed to prevent
  // duplicate-class collisions with expo-image and other Glide-based libraries.
  afterEvaluate {
    def docusignProject = rootProject.findProject(':react-native-docusign')
    if (docusignProject != null) {
      repositories {
        flatDir { dirs "\${docusignProject.projectDir}/libs" }
      }
    }
  }`;

    const allprojectsRegex = /(allprojects\s*\{(?:[^{}]|\{[^{}]*\})*)(\n\})/;
    if (allprojectsRegex.test(cfg.modResults.contents)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        allprojectsRegex,
        `$1\n${flatDirBlock}$2`,
      );
    }

    return cfg;
  });

/**
 * Downloads the upstream `com.docusign:sdk-pdf:2.1.4` AAR from DocuSign's
 * public Maven repository and strips the pre-generated
 * `com.bumptech.glide.GeneratedAppGlideModuleImpl` class from its
 * `classes.jar`. The stripped artifact is written to
 * `node_modules/react-native-docusign/android/libs/` so the existing flatDir
 * Gradle injection (added by `withDocuSignAndroidStrippedAarFlatDir`) can
 * resolve it at consumer build time.
 *
 * The strip prevents a duplicate-class collision at the consumer's
 * `mergeDexDebug` / `mergeDexRelease` step when the host app also includes
 * any other `@GlideModule`-bearing library (e.g. `expo-image`).
 *
 * The AAR is fetched from DocuSign's official CDN, processed in-memory, and
 * cached locally. The package itself never redistributes any DocuSign
 * binary; consumers fetch it directly from DocuSign at prebuild time.
 */
async function fetchUpstreamSdkPdfAar(): Promise<Buffer> {
  const response = await fetch(SDK_PDF_UPSTREAM_URL);
  if (!response.ok) {
    throw new Error(
      `[react-native-docusign] Failed to download sdk-pdf-${SDK_PDF_VERSION}.aar from DocuSign Maven (HTTP ${response.status}). URL: ${SDK_PDF_UPSTREAM_URL}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256Hex(buffer);
  if (actual !== SDK_PDF_SHA256) {
    throw new Error(
      `[react-native-docusign] SHA-256 mismatch on downloaded sdk-pdf-${SDK_PDF_VERSION}.aar.\n  expected: ${SDK_PDF_SHA256}\n  actual:   ${actual}\nThe upstream binary at ${SDK_PDF_UPSTREAM_URL} does not match the version this plugin was built against. Refusing to write a binary we cannot vouch for. Causes: CDN compromise, DNS hijack, partial download, or DocuSign re-cut the artifact under the same version. If DocuSign re-cut, bump react-native-docusign and update SDK_PDF_SHA256 in plugin/src/index.ts.`,
    );
  }
  return buffer;
}

function stripGlideClassFromAar(aarBuffer: Buffer): Buffer {
  // adm-zip is loaded lazily so unit tests that never touch this codepath do
  // not require the dep to be installed.

  const AdmZip = require('adm-zip') as typeof import('adm-zip');

  const aar = new AdmZip(aarBuffer);
  const classesEntry = aar.getEntry('classes.jar');
  if (!classesEntry) {
    throw new Error(
      `[react-native-docusign] Upstream sdk-pdf-${SDK_PDF_VERSION}.aar is missing classes.jar. Refusing to write a malformed artifact. The upstream may have changed structure; please file an issue.`,
    );
  }

  const classesJar = new AdmZip(classesEntry.getData());
  if (!classesJar.getEntry(GLIDE_GENERATED_CLASS)) {
    // Already stripped or upstream changed. Either way, write the AAR as-is.
    return aarBuffer;
  }
  classesJar.deleteFile(GLIDE_GENERATED_CLASS);
  aar.updateFile('classes.jar', classesJar.toBuffer());
  return aar.toBuffer();
}

const withDocuSignAndroidStripDocusignSdkPdf: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      // Resolve the installed package's android/libs/ directory so the
      // `flatDir` injection (which references docusignProject.projectDir/libs)
      // finds the stripped AAR.
      let packageRoot: string;
      try {
        const packageJsonPath = require.resolve(
          'react-native-docusign/package.json',
          { paths: [cfg.modRequest.projectRoot] },
        );
        packageRoot = path.dirname(packageJsonPath);
      } catch {
        WarningAggregator.addWarningAndroid(
          'react-native-docusign',
          'Could not resolve react-native-docusign package root from the consumer project. Skipping sdk-pdf strip; expect a duplicate-class collision at dex time if the host app uses expo-image or another Glide-based library.',
        );
        return cfg;
      }

      const libsDir = path.join(packageRoot, 'android', 'libs');
      const targetPath = path.join(libsDir, STRIPPED_AAR_FILENAME);

      // Cache check: only reuse the existing artifact if it is non-empty AND
      // its central directory parses as a valid AAR. A zero-byte file or a
      // corrupted partial write from an interrupted prior prebuild gets
      // regenerated rather than poisoning the consumer's build.
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.size > 0 && isValidAar(targetPath)) {
          return cfg;
        }
        fs.unlinkSync(targetPath);
      }

      fs.mkdirSync(libsDir, { recursive: true });

      // Hard-fail on any error. A silent WarningAggregator entry would let
      // `expo prebuild` exit 0 and the consumer would only discover the
      // missing AAR hours later as a cryptic dex duplicate-class failure.
      const upstream = await fetchUpstreamSdkPdfAar();
      const stripped = stripGlideClassFromAar(upstream);
      fs.writeFileSync(targetPath, stripped);

      return cfg;
    },
  ]);

const withDocuSign: ConfigPlugin<DocuSignPluginProps | void> = (
  config,
  props,
) => {
  const resolvedProps: DocuSignPluginProps = props ?? {};
  let updated = config;
  updated = withDocuSignIos(updated, resolvedProps);
  updated = withDocuSignAndroidPermissions(updated);
  updated = withDocuSignAndroidMavenRepo(updated, resolvedProps);
  updated = withDocuSignAndroidStripDocusignSdkPdf(updated);
  updated = withDocuSignAndroidStrippedAarFlatDir(updated);
  return updated;
};

export default withDocuSign;
