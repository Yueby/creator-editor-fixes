const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

/** deflate 压缩；压不下去（小文件）就退回 store，避免反而变大。 */
function compressEntry(data) {
    if (data.length === 0) return { method: 0, payload: data };
    const deflated = zlib.deflateRawSync(data, { level: zlib.constants.Z_BEST_COMPRESSION });
    return deflated.length < data.length ? { method: 8, payload: deflated } : { method: 0, payload: data };
}

function createZip(files, outputPath) {
    const now = getDosTime(new Date());
    const chunks = [];
    const centralChunks = [];
    let offset = 0;
    let rawTotal = 0;
    let storedTotal = 0;

    for (const file of files) {
        const data = fs.readFileSync(file.diskPath);
        const name = Buffer.from(file.zipPath.replace(/\\/g, '/'));
        const crc = crc32(data);
        const { method, payload } = compressEntry(data);
        rawTotal += data.length;
        storedTotal += payload.length;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt16LE(now.dosTime, 10);
        localHeader.writeUInt16LE(now.dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(payload.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);

        chunks.push(localHeader, name, payload);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0, 8);
        centralHeader.writeUInt16LE(method, 10);
        centralHeader.writeUInt16LE(now.dosTime, 12);
        centralHeader.writeUInt16LE(now.dosDate, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(payload.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralChunks.push(centralHeader, name);

        offset += localHeader.length + name.length + payload.length;
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
    return { rawTotal, storedTotal };
}

/** 生成后自检：按 central directory 逐条解压，校验 CRC 与原始字节一致。 */
function verifyZip(zipPath, files) {
    const buffer = fs.readFileSync(zipPath);
    const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endOffset < 0) throw new Error('zip 自检失败：找不到 end of central directory');
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    if (entryCount !== files.length) throw new Error(`zip 自检失败：条目数 ${entryCount} != ${files.length}`);

    let cursor = buffer.readUInt32LE(endOffset + 16);
    for (let index = 0; index < entryCount; index++) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip 自检失败：central header 签名错误');
        const method = buffer.readUInt16LE(cursor + 10);
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const payload = buffer.subarray(dataStart, dataStart + compressedSize);
        const restored = method === 8 ? zlib.inflateRawSync(payload) : payload;

        if (restored.length !== uncompressedSize) throw new Error(`zip 自检失败：${name} 解压后长度不符`);
        if (crc32(restored) !== crc) throw new Error(`zip 自检失败：${name} CRC 不符`);
        const expected = files.find((file) => file.zipPath.replace(/\\/g, '/') === name);
        if (!expected) throw new Error(`zip 自检失败：${name} 不在预期文件列表中`);
        if (!restored.equals(fs.readFileSync(expected.diskPath))) throw new Error(`zip 自检失败：${name} 内容与 dist 不一致`);

        cursor += 46 + nameLength + extraLength + commentLength;
    }
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
    const entries = [
        ...collectDistScripts(DIST_DIR),
        { zipPath: 'package.json', diskPath: releasePackagePath },
    ];
    const { rawTotal, storedTotal } = createZip(entries, zipPath);
    verifyZip(zipPath, entries);

    const zipSize = fs.statSync(zipPath).size;
    const ratio = rawTotal > 0 ? Math.round((1 - storedTotal / rawTotal) * 100) : 0;
    console.log(`已生成发布包：${path.relative(PACKAGE_ROOT, zipPath)}`);
    console.log(`文件 ${entries.length} 个，原始 ${rawTotal} 字节 -> zip ${zipSize} 字节（deflate 压缩率 ${ratio}%，已通过解压自检）`);
}

main();
