#!/usr/bin/env node
// Adds the Linux app to a release's update feed.
//
// latest.json is the manifest every installed copy polls (README: Releasing). tauri-action
// writes it while building Windows and macOS; the Linux app is built by electron-builder in a
// job of its own, so its entries are added here afterwards, in the shape tauri-action gives
// every platform: { signature, url }, the signature being the text of the `.sig` file
// `tauri signer sign` writes beside the artifact, unchanged. Two updaters read them - the
// Tauri one in Linux installs from before the move to Electron, and the Electron shell's own -
// and both pick the entry for how they were installed:
//
//   linux-x86_64-appimage, linux-x86_64   the AppImage (the bare key is what an updater that
//                                         does not know its bundle type falls back to)
//   linux-x86_64-deb, linux-x86_64-rpm    the packages
//
// Usage:
//   node scripts/linux-update-feed.mjs --feed latest.json --base-url <release download url> \
//     --appimage <file> --deb <file> --rpm <file> [--out latest.json] [--pubkey <file>]
//
// --out defaults to --feed (rewritten in place). --pubkey is a file holding the updater's
// public key; by default it is the one in src-tauri/tauri.conf.json, which every installed
// copy checks against.
//
// It refuses, writing nothing, when a .sig is missing, does not verify, or was made for
// another file or version, and when the artifacts' version is not the feed's: a feed that
// pairs one version with another's files offers every Linux install an update it can never
// apply, or the same one forever.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
// The shell's own verifier, so this checks exactly what an installed Electron app will.
const minisign = require('../electron/src/minisign.js');

/** Each artifact: how its name looks (the Tauri bundler's naming, which electron-builder.yml
 * keeps) and the feed entries it fills. */
export const ARTIFACTS = {
  appimage: { pattern: /^Strafe_(.+)_amd64\.AppImage$/, example: 'Strafe_<version>_amd64.AppImage', keys: ['linux-x86_64', 'linux-x86_64-appimage'] },
  deb: { pattern: /^Strafe_(.+)_amd64\.deb$/, example: 'Strafe_<version>_amd64.deb', keys: ['linux-x86_64-deb'] },
  rpm: { pattern: /^Strafe-(.+)-1\.x86_64\.rpm$/, example: 'Strafe-<version>-1.x86_64.rpm', keys: ['linux-x86_64-rpm'] },
};

/** The `key:value` fields of a signature's trusted comment: `timestamp`, `file` and, when
 * signed with `--app-version` (as `tauri build` does), `version`. */
export function signedFields(signature) {
  const { trustedComment } = minisign.parseSignature(signature);
  const fields = {};
  for (const field of trustedComment.split('\t')) {
    const colon = field.indexOf(':');
    if (colon > 0) fields[field.slice(0, colon)] = field.slice(colon + 1);
  }
  return fields;
}

/**
 * The feed with the Linux entries set. `artifacts` maps appimage/deb/rpm to
 * `{ name, signature }`: the file's name as published and its .sig text. Pure - the input is
 * not changed, and nothing here touches a file or checks a signature's cryptography (the
 * command line below does that before calling it). Throws when anything does not line up.
 */
export function addLinuxEntries(feed, { baseUrl, artifacts }) {
  if (!feed || typeof feed.version !== 'string' || !feed.platforms || typeof feed.platforms !== 'object') {
    throw new Error('not an update feed: expected { version, platforms }');
  }
  // tauri-action writes the bare version; an updater would accept a leading "v" too.
  const version = feed.version.replace(/^v/, '');
  const base = String(baseUrl).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error(`base URL must be https: ${baseUrl}`);

  const platforms = { ...feed.platforms };
  for (const [kind, { pattern, example, keys }] of Object.entries(ARTIFACTS)) {
    const artifact = artifacts?.[kind];
    if (!artifact) throw new Error(`no ${kind} given`);
    const { name } = artifact;
    const match = pattern.exec(name);
    if (!match) throw new Error(`${name}: not a ${kind} name, expected ${example}`);
    if (match[1] !== version) throw new Error(`${name} is version ${match[1]}, but the feed is for ${version}`);

    // The .sig text as tauri-action takes it. It has no trailing newline; trimmed anyway,
    // because the Tauri updater's base64 decoder rejects whitespace.
    const signature = String(artifact.signature ?? '').trim();
    if (!signature) throw new Error(`${name}: no signature`);
    let signed;
    try {
      signed = signedFields(signature);
    } catch (err) {
      throw new Error(`${name}: unreadable signature (${err.message})`);
    }
    if (signed.file !== name) throw new Error(`${name}: the signature is for ${signed.file ?? 'an unnamed file'}`);
    if (signed.version !== version) {
      throw new Error(
        signed.version
          ? `${name}: the signature is for version ${signed.version}`
          : `${name}: the signature names no version - sign with \`tauri signer sign --app-version ${version}\``,
      );
    }

    const url = `${base}/${encodeURIComponent(name)}`;
    for (const key of keys) platforms[key] = { signature, url };
  }
  return { ...feed, platforms };
}

async function readSignature(file) {
  try {
    return (await readFile(`${file}.sig`, 'utf8')).trim();
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${file}.sig is missing - sign it with \`tauri signer sign --app-version <version> ${file}\``);
    throw err;
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      feed: { type: 'string' },
      'base-url': { type: 'string' },
      appimage: { type: 'string' },
      deb: { type: 'string' },
      rpm: { type: 'string' },
      out: { type: 'string' },
      pubkey: { type: 'string' },
    },
  });
  const missing = ['feed', 'base-url', ...Object.keys(ARTIFACTS)].filter((k) => !values[k]);
  if (missing.length) {
    throw new Error(`missing ${missing.map((k) => `--${k}`).join(', ')}\nusage: node scripts/linux-update-feed.mjs --feed latest.json --base-url <url> --appimage <file> --deb <file> --rpm <file> [--out <file>] [--pubkey <file>]`);
  }

  const feed = JSON.parse(await readFile(values.feed, 'utf8'));
  const pubkey = values.pubkey
    ? await readFile(values.pubkey, 'utf8')
    : JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).plugins.updater.pubkey;

  const artifacts = {};
  for (const kind of Object.keys(ARTIFACTS)) {
    const file = values[kind];
    const signature = await readSignature(file);
    // What an installed copy will do before installing it: an entry that fails here would
    // fail on every machine that downloads it.
    if (!minisign.verify(await readFile(file), signature, pubkey)) {
      throw new Error(`${file}.sig does not verify against the updater's public key`);
    }
    artifacts[kind] = { name: path.basename(file), signature };
  }

  const updated = addLinuxEntries(feed, { baseUrl: values['base-url'], artifacts });
  const out = values.out ?? values.feed;
  await writeFile(out, `${JSON.stringify(updated, null, 2)}\n`);
  const keys = Object.values(ARTIFACTS).flatMap((a) => a.keys);
  console.log(`${out}: ${keys.join(', ')} -> ${updated.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`linux-update-feed: ${err.message}`);
    process.exit(1);
  });
}
