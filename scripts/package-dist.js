const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const SOURCE_PACKAGE_PATH = path.join(PACKAGE_ROOT, 'package.json');

function ensureFile(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`缺少发布文件：${path.relative(PACKAGE_ROOT, filePath)}`);
}

function createReleasePackage(sourcePackage) {
    const contributions = { ...sourcePackage.contributions };
    contributions.scene = {
        ...(contributions.scene || {}),
        script: './scene.js',
    };

    return {
        package_version: sourcePackage.package_version,
        name: sourcePackage.name,
        version: sourcePackage.version,
        author: sourcePackage.author,
        editor: sourcePackage.editor,
        description: sourcePackage.description,
        main: './main.js',
        creator: {
            ...(sourcePackage.creator || {}),
            hookScript: './fixes/inspector-i18n-listener-leak/hook.js',
        },
        contributions,
    };
}

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function getDosTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function createZip(files, outputPath) {
    const now = getDosTime(new Date());
    const chunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const file of files) {
        const data = fs.readFileSync(file.diskPath);
        const name = Buffer.from(file.zipPath.replace(/\\/g, '/'));
        const crc = crc32(data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(now.dosTime, 10);
        localHeader.writeUInt16LE(now.dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);

        chunks.push(localHeader, name, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(now.dosTime, 12);
        centralHeader.writeUInt16LE(now.dosDate, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralChunks.push(centralHeader, name);

        offset += localHeader.length + name.length + data.length;
    }

    const centralOffset = offset;
    const centralSize = centralChunks.reduce((size, chunk) => size + chunk.length, 0);
    const endHeader = Buffer.alloc(22);
    endHeader.writeUInt32LE(0x06054b50, 0);
    endHeader.writeUInt16LE(0, 4);
    endHeader.writeUInt16LE(0, 6);
    endHeader.writeUInt16LE(files.length, 8);
    endHeader.writeUInt16LE(files.length, 10);
    endHeader.writeUInt32LE(centralSize, 12);
    endHeader.writeUInt32LE(centralOffset, 16);
    endHeader.writeUInt16LE(0, 20);

    fs.writeFileSync(outputPath, Buffer.concat([...chunks, ...centralChunks, endHeader]));
}

function collectDistScripts(dir, prefix = '') {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const diskPath = path.join(dir, entry.name);
        const zipPath = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
            files.push(...collectDistScripts(diskPath, zipPath));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push({ zipPath, diskPath });
        }
    }
    return files;
}

function main() {
    ensureFile(path.join(DIST_DIR, 'main.js'));
    ensureFile(path.join(DIST_DIR, 'scene.js'));

    const sourcePackage = JSON.parse(fs.readFileSync(SOURCE_PACKAGE_PATH, 'utf8'));
    const releasePackage = createReleasePackage(sourcePackage);
    const releasePackagePath = path.join(DIST_DIR, 'package.json');
    fs.writeFileSync(releasePackagePath, `${JSON.stringify(releasePackage, null, 4)}\n`);

    const zipName = `${sourcePackage.name}-${sourcePackage.version}.zip`;
    const zipPath = path.join(DIST_DIR, zipName);
    createZip([
        ...collectDistScripts(DIST_DIR),
        { zipPath: 'package.json', diskPath: releasePackagePath },
    ], zipPath);

    console.log(`已生成发布包：${path.relative(PACKAGE_ROOT, zipPath)}`);
}

main();
