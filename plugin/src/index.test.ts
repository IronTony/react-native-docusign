import { describe, expect, it } from '@jest/globals';
import type { ExportedConfig } from 'expo/config-plugins';

import withDocuSign, { type DocuSignPluginProps } from './index';

const DOCUSIGN_REPO = 'https://docucdn-a.akamaihd.net/prod/docusignandroidsdk';
const CUSTOM_REPO = 'https://maven.example.com/docusign';

function buildProjectGradle(repositories: string[]): string {
  return [
    'buildscript {',
    '  repositories {',
    '    google()',
    '  }',
    '}',
    '',
    'allprojects {',
    '  repositories {',
    ...repositories.map((line) => `    ${line}`),
    '    google()',
    '    mavenCentral()',
    '  }',
    '}',
    '',
  ].join('\n');
}

async function applyProjectBuildGradleMods(
  contents: string,
  props?: DocuSignPluginProps,
): Promise<string> {
  const config: ExportedConfig = withDocuSign(
    { name: 'app', slug: 'app' },
    props,
  );
  const mod = config.mods?.android?.projectBuildGradle;
  if (!mod) {
    throw new Error('withDocuSign registered no projectBuildGradle mod');
  }
  const result = await mod({
    ...config,
    modRawConfig: config,
    modResults: { path: 'android/build.gradle', language: 'groovy', contents },
    modRequest: {
      projectRoot: '/app',
      platformProjectRoot: '/app/android',
      modName: 'projectBuildGradle',
      platform: 'android',
      introspect: false,
    },
  });
  return result.modResults.contents;
}

function countOccurrences(contents: string, needle: string): number {
  return contents.split(needle).length - 1;
}

describe('withDocuSign android maven repository', () => {
  it('adds the DocuSign repository inside allprojects.repositories', async () => {
    const contents = await applyProjectBuildGradleMods(buildProjectGradle([]));

    expect(contents).toContain(
      `allprojects {\n  repositories {\n        maven { url "${DOCUSIGN_REPO}" }`,
    );
  });

  it('changes build.gradle only by adding the DocuSign repository', async () => {
    const original = buildProjectGradle([]);

    const contents = await applyProjectBuildGradleMods(original);

    expect(contents).toBe(
      original.replace(
        'allprojects {\n  repositories {',
        `allprojects {\n  repositories {\n        maven { url "${DOCUSIGN_REPO}" }`,
      ),
    );
  });

  it('adds androidMavenRepo instead of the DocuSign repository when provided', async () => {
    const contents = await applyProjectBuildGradleMods(buildProjectGradle([]), {
      androidMavenRepo: CUSTOM_REPO,
    });

    expect(contents).toContain(`maven { url "${CUSTOM_REPO}" }`);
    expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(0);
  });

  it.each([
    ['a double-quoted url', `maven { url "${DOCUSIGN_REPO}" }`],
    ['a single-quoted url', `maven { url '${DOCUSIGN_REPO}' }`],
    ['a uri() assignment', `maven { url = uri("${DOCUSIGN_REPO}") }`],
    ['a trailing slash', `maven { url "${DOCUSIGN_REPO}/" }`],
    ['a multi-line block', `maven {\n      url "${DOCUSIGN_REPO}"\n    }`],
  ])(
    'does not add the repository when build.gradle declares it with %s',
    async (_label, declaration) => {
      const contents = await applyProjectBuildGradleMods(
        buildProjectGradle([declaration]),
      );

      expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(1);
    },
  );

  it('does not add the repository when a declaration is followed by a line comment', async () => {
    const contents = await applyProjectBuildGradleMods(
      buildProjectGradle([`maven { url "${DOCUSIGN_REPO}" } // DocuSign SDK`]),
    );

    expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(1);
  });

  it('does not add the repository when an earlier string on its line contains an escaped quote', async () => {
    const contents = await applyProjectBuildGradleMods(
      buildProjectGradle([
        `def note = "a\\"b"; maven { url "${DOCUSIGN_REPO}" }`,
      ]),
    );

    expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(1);
  });

  it('does not treat comment markers inside strings as comments', async () => {
    const contents = await applyProjectBuildGradleMods(
      buildProjectGradle([
        "flatDir { dirs 'libs/*' }",
        `maven { url "${DOCUSIGN_REPO}" }`,
        "flatDir { dirs 'vendor/**/' }",
      ]),
    );

    expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(1);
  });

  it.each([
    ['a line comment', `// maven { url "${DOCUSIGN_REPO}" }`],
    ['a block comment', `/* maven { url "${DOCUSIGN_REPO}" } */`],
    [
      'a multi-line block comment',
      `/*\n      maven { url "${DOCUSIGN_REPO}" }\n    */`,
    ],
  ])(
    'adds the repository when the only declaration is inside %s',
    async (_label, declaration) => {
      const contents = await applyProjectBuildGradleMods(
        buildProjectGradle([declaration]),
      );

      expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(2);
    },
  );

  it('adds the repository when build.gradle only declares a longer url with the same prefix', async () => {
    const contents = await applyProjectBuildGradleMods(
      buildProjectGradle([`maven { url "${DOCUSIGN_REPO}/legacy" }`]),
    );

    expect(countOccurrences(contents, DOCUSIGN_REPO)).toBe(2);
  });

  it('leaves build.gradle unchanged when the plugin runs again', async () => {
    const firstRun = await applyProjectBuildGradleMods(buildProjectGradle([]));
    const secondRun = await applyProjectBuildGradleMods(firstRun);

    expect(secondRun).toBe(firstRun);
  });
});
