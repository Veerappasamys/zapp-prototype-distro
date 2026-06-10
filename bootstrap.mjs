#!/usr/bin/env node
/**
 * Self-contained bootstrap published to zapp-prototype-distro (curl … | node).
 * @distro-version 0.5.0
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const USER_CWD = process.cwd();

function isWritableDirectory(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

function resolveKitCacheRoot(workspaceCwd) {
    // 1. Explicit override always wins.
    if (process.env.ZAPP_KIT_CACHE) {
        return path.resolve(process.env.ZAPP_KIT_CACHE);
    }

    // Workspace-local cache ONLY — never $HOME. The kit cache stays inside the
    // folder you run in, so there are no home-directory or admin writes.
    const workspaceCache = path.join(workspaceCwd, '.zapp-prototype-kit');
    if (isWritableDirectory(workspaceCache)) {
        return workspaceCache;
    }

    throw new Error(
        `Cannot write kit cache to ${workspaceCache}. ` +
            'Set ZAPP_KIT_CACHE to a writable path inside your workspace, e.g.\n' +
            '  ZAPP_KIT_CACHE="$(pwd)/.zapp-prototype-kit" node zapp-bootstrap.mjs'
    );
}

const KIT_CACHE_ROOT = resolveKitCacheRoot(USER_CWD);
const KIT_BUNDLE_DIR = path.join(KIT_CACHE_ROOT, 'bundle');
const DEFAULT_TARBALL_URL = process.env.ZAPP_KIT_TARBALL_URL || '';
const DISTRO_MANIFEST_URL =
    process.env.ZAPP_DISTRO_MANIFEST_URL ||
    'https://raw.githubusercontent.com/Veerappasamys/zapp-prototype-distro/main/latest.json';
const DISTRO_BOOTSTRAP_URL =
    process.env.ZAPP_DISTRO_BOOTSTRAP_URL ||
    'https://cdn.jsdelivr.net/gh/Veerappasamys/zapp-prototype-distro@main/bootstrap.mjs';

function forwardArgs() {
    const args = process.argv.slice(2).filter(Boolean);
    const hasOpenFlag = args.includes('--open') || args.includes('--no-open');
    if (!hasOpenFlag) args.unshift('--no-open');
    return args;
}

function bootstrapHelp() {
    return `
Prototype bootstrap could not complete. This installer only needs the PUBLIC distro —
no private repo or special access is required. To retry:

  1. Make sure you are inside the folder you want the prototype in:
       cd "<your-project-folder>"

  2. Download the bootstrap, then run the saved file (sandbox-safe — no curl|node pipe):
       curl -fsSL ${DISTRO_BOOTSTRAP_URL} -o zapp-bootstrap.mjs
       node zapp-bootstrap.mjs

The kit cache is written to ./.zapp-prototype-kit inside this folder, so it works in
sandboxes (Codex, Cursor) without any $HOME or admin permission. If a network step is
blocked, approve network access for that one command and run it again.
`.trim();
}

function kitIsValid(kitRoot) {
    if (!fs.existsSync(path.join(kitRoot, 'kit-manifest.json'))) return false;

    const required = [
        'scaffold/index.html',
        'tabs/homepage.html',
        'tabs/bank-tab.html',
        'nav/screen-runtime.js',
        'nav/zapp-screens.css',
        'templates/_shared/drill-down-list-screen.html',
        'templates/portable/landing-page.html',
        'skill/scripts/run-init.mjs',
        'uds/foundations/manifest.json',
        'uds/foundations/icons/24/check.svg',
        'uds/components/key-value.css',
    ];

    for (const rel of required) {
        if (!fs.existsSync(path.join(kitRoot, rel))) return false;
    }

    const html = fs.readFileSync(path.join(kitRoot, 'scaffold/index.html'), 'utf8');
    return (
        html.includes('zapp-tab-shell') &&
        html.includes('tabs/homepage.html') &&
        !html.includes('zapp-helper-hint')
    );
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function readChecksumFile(checksumPath) {
    if (!fs.existsSync(checksumPath)) return null;
    const line = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
    return line || null;
}

function resolveLocalTarballPath(url) {
    if (url.startsWith('file://')) return fileURLToPath(url);
    if (url.startsWith('~/')) return path.join(os.homedir(), url.slice(2));
    if (path.isAbsolute(url) && fs.existsSync(url)) return url;
    return null;
}

async function downloadFile(url, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const localPath = resolveLocalTarballPath(url);
    if (localPath) {
        fs.copyFileSync(localPath, dest);
        return dest;
    }
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
    return dest;
}

function extractTarball(tarballPath, destDir) {
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    const result = spawnSync('tar', ['-xzf', tarballPath, '-C', destDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`tar extract failed for ${tarballPath}`);
}

function resolveSkillSandbox(kitRoot) {
    const sandbox = path.join(KIT_CACHE_ROOT, 'skill-sandbox');
    const skillKit = path.join(kitRoot, 'skill');
    const skillDest = path.join(sandbox, '.agents/skills/zapp-prototype');
    const assetsDest = path.join(skillDest, 'assets/kit');

    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    if (fs.existsSync(skillDest)) fs.rmSync(skillDest, { recursive: true, force: true });

    if (!fs.existsSync(skillKit)) {
        throw new Error('Kit tarball is missing skill/ — rebuild with publish:prototype-distro');
    }
    fs.cpSync(skillKit, skillDest, { recursive: true });

    fs.mkdirSync(path.dirname(assetsDest), { recursive: true });
    if (fs.existsSync(assetsDest)) fs.rmSync(assetsDest, { recursive: true, force: true });
    fs.cpSync(kitRoot, assetsDest, { recursive: true });

    return skillDest;
}

async function ensureKitFromTarball(url, expectedSha256) {
    const tarballPath = path.join(KIT_CACHE_ROOT, 'kit.tar.gz');
    const kitRoot = KIT_BUNDLE_DIR;

    if (kitIsValid(kitRoot)) return { kitRoot, source: 'tarball-cache' };

    console.log('Downloading prototype kit...');
    await downloadFile(url, tarballPath);

    if (expectedSha256 && sha256File(tarballPath) !== expectedSha256) {
        throw new Error('Kit tarball checksum mismatch.');
    }

    const checksumUrl = process.env.ZAPP_KIT_CHECKSUM_URL;
    if (!expectedSha256 && checksumUrl) {
        const checksumDest = path.join(KIT_CACHE_ROOT, 'kit.sha256');
        await downloadFile(checksumUrl, checksumDest);
        const expected = readChecksumFile(checksumDest);
        if (expected && sha256File(tarballPath) !== expected) {
            throw new Error('Kit tarball checksum mismatch.');
        }
    }

    extractTarball(tarballPath, KIT_BUNDLE_DIR);
    if (!kitIsValid(kitRoot)) throw new Error('Downloaded kit is incomplete or corrupt.');
    return { kitRoot, source: 'tarball' };
}

async function fetchDistroManifest() {
    const response = await fetch(DISTRO_MANIFEST_URL, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`Distro manifest unavailable (HTTP ${response.status})`);
    }
    const manifest = await response.json();
    if (!manifest.tarballUrl) {
        throw new Error('Distro manifest missing tarballUrl');
    }
    return manifest;
}

function runInitFromSkill(skillRoot, kitRoot) {
    const runInit = path.join(skillRoot, 'scripts/run-init.mjs');
    if (!fs.existsSync(runInit)) {
        console.error('run-init.mjs not found.');
        process.exit(1);
    }

    process.env.ZAPP_KIT_DIR = kitRoot;
    process.env.ZAPP_USER_CWD = USER_CWD;

    const args = [runInit, ...forwardArgs()];
    const result = spawnSync(process.execPath, args, {
        cwd: USER_CWD,
        stdio: 'inherit',
        env: process.env,
    });
    process.exit(result.status ?? 0);
}

async function tryDistroBootstrap() {
    let tarballUrl = DEFAULT_TARBALL_URL;
    let fallbackUrl;
    let expectedSha256;

    if (!tarballUrl) {
        try {
            const manifest = await fetchDistroManifest();
            tarballUrl = manifest.tarballUrl;
            fallbackUrl = manifest.tarballUrlFallback;
            expectedSha256 = manifest.sha256;
            console.log(`Using prototype kit v${manifest.version ?? 'unknown'} from public distro`);
        } catch (err) {
            if (DEFAULT_TARBALL_URL) throw err;
            return false;
        }
    }

    let kitRoot;
    try {
        ({ kitRoot } = await ensureKitFromTarball(tarballUrl, expectedSha256));
    } catch (err) {
        if (!fallbackUrl || fallbackUrl === tarballUrl) throw err;
        console.warn(`CDN download failed (${err.message}); retrying from ${fallbackUrl}`);
        ({ kitRoot } = await ensureKitFromTarball(fallbackUrl, expectedSha256));
    }

    const skillRoot = resolveSkillSandbox(kitRoot);
    runInitFromSkill(skillRoot, kitRoot);
    return true;
}

async function tryCachedTarballBootstrap() {
    if (!kitIsValid(KIT_BUNDLE_DIR)) return false;
    console.log('Using cached prototype kit...');
    const skillRoot = resolveSkillSandbox(KIT_BUNDLE_DIR);
    runInitFromSkill(skillRoot, KIT_BUNDLE_DIR);
    return true;
}

async function main() {
    if (await tryDistroBootstrap()) return;
    if (await tryCachedTarballBootstrap()) return;

    console.error(bootstrapHelp());
    process.exit(1);
}

main().catch((err) => {
    console.error(err.message || err);
    console.error(bootstrapHelp());
    process.exit(1);
});
