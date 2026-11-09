// ======================== MD5（RFC 1321） ========================
// 接口校验与 b/c 编码必需，浏览器无内置 MD5，手写最小实现

const MD5_SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

function md5Digest(bytes) {
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    padded[padded.length - 8] = bitLength & 0xff;
    padded[padded.length - 7] = (bitLength >>> 8) & 0xff;
    padded[padded.length - 6] = (bitLength >>> 16) & 0xff;
    padded[padded.length - 5] = (bitLength >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const words = new Uint32Array(16);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const at = offset + i * 4;
            words[i] = padded[at] | (padded[at + 1] << 8) | (padded[at + 2] << 16) | (padded[at + 3] << 24);
        }
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            const sum = (a + f + MD5_K[i] + words[g]) | 0;
            const oldD = d;
            d = c;
            c = b;
            b = (b + ((sum << MD5_SHIFT[i]) | (sum >>> (32 - MD5_SHIFT[i])))) | 0;
            a = oldD;
        }
        a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }

    const digest = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((word, i) => {
        digest[i * 4] = word & 0xff;
        digest[i * 4 + 1] = (word >>> 8) & 0xff;
        digest[i * 4 + 2] = (word >>> 16) & 0xff;
        digest[i * 4 + 3] = (word >>> 24) & 0xff;
    });
    return digest;
}

const HEX = '0123456789abcdef';

export function md5Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = md5Digest(bytes);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += HEX[digest[i] >> 4] + HEX[digest[i] & 15];
    return hex;
}

// ======================== b/c 编码 ========================
// bookId/chapterUid/ct → 编码串，与阅读页 URL hash 同源的正向函数

export function wereadE(value) {
    const s = String(value);
    const hash = md5Hex(s);
    let result = hash.slice(0, 3);

    let chunks;
    let typeFlag;
    if (/^[0-9]+$/.test(s)) {
        chunks = [];
        for (let i = 0; i < s.length; i += 9) chunks.push(Number(s.slice(i, i + 9)).toString(16));
        typeFlag = '3';
    } else {
        let joined = '';
        for (const ch of s) joined += ch.codePointAt(0).toString(16);
        chunks = [joined];
        typeFlag = '4';
    }

    result += typeFlag + '2' + hash.slice(-2);
    chunks.forEach((chunk, index) => {
        result += chunk.length.toString(16).padStart(2, '0') + chunk;
        if (index < chunks.length - 1) result += 'g';
    });
    if (result.length < 20) result += hash.slice(0, 20 - result.length);
    result += md5Hex(result).slice(0, 3);
    return result;
}

// ======================== 签名 ========================

function jsString(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === null || value === undefined) return 'null';
    return String(value);
}

// 对齐 Python urllib.parse.quote(safe='')：encodeURIComponent 不转义 !'()*，此处补齐
function quoteParam(value) {
    return encodeURIComponent(jsString(value))
        .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function sortedQuery(params) {
    return Object.keys(params).sort()
        .map((key) => key + '=' + quoteParam(params[key]))
        .join('&');
}

export function wereadSign(query) {
    let a = 0x15051505;
    let b = 0x15051505;
    const length = query.length;
    let i = length - 1;
    while (i > 0) {
        a = (a ^ (query.charCodeAt(i) << ((length - i) % 30))) & 0x7fffffff;
        b = (b ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
        i -= 2;
    }
    return (a + b).toString(16);
}

// 组装分片请求参数；now（毫秒）与 random（[0,1)）注入保证可测
export function buildContentParams({ bookId, chapterUid, psvts, now, random, style = false, sc = 1 }) {
    let ctValue = Math.floor(now / 1000);
    let ct = String(ctValue);
    if (wereadE(ct) === psvts) {
        ctValue += 1;
        ct = String(ctValue);
    }
    const params = {
        b: wereadE(bookId),
        c: wereadE(chapterUid),
        r: String(Math.floor(random * 10000) ** 2),
        ct,
        ps: psvts,
        pc: wereadE(ct),
        sc,
        prevChapter: false,
        st: style ? 1 : 0
    };
    return { ...params, s: wereadSign(sortedQuery(params)) };
}

// ======================== 响应校验与解码 ========================
// 分片响应 = 前 32 字符大写 MD5 前缀 + 置乱体；逆交换后 base64url 还原为 XHTML

export function checkedBody(responseText) {
    if (!/^[0-9a-f]{32}/i.test(responseText)) throw new Error('章节分片缺失或无效');
    const expected = responseText.slice(0, 32);
    const body = responseText.slice(32);
    const actual = md5Hex(body).toUpperCase();
    if (actual !== expected.toUpperCase()) {
        throw new Error('分片 MD5 校验失败: expected=' + expected + ', actual=' + actual);
    }
    return body;
}

export function swapPositions(encoded) {
    const length = encoded.length;
    if (length < 4) return [];
    if (length < 11) return [0, 2];

    const n = Math.min(4, Math.floor((length + 9) / 10));
    let tmp = '';
    for (let i = length - 1; i >= length - n; i--) {
        // 二进制位串按四进制解读（参考实现原样行为）
        tmp += parseInt(encoded.charCodeAt(i).toString(2), 4);
    }

    const positions = [];
    const m = length - n - 2;
    const step = String(m).length;
    let i = 0;
    while (positions.length < 10 && i + step < tmp.length) {
        positions.push(parseInt(tmp.slice(i, i + step), 10) % m);
        positions.push(parseInt(tmp.slice(i + 1, i + 1 + step), 10) % m);
        i += step;
    }
    return positions;
}

function reverseSwaps(encoded, positions) {
    const chars = encoded.split('');
    for (let i = positions.length - 1; i >= 0; i -= 2) {
        for (const k of [1, 0]) {
            const left = positions[i] + k;
            const right = positions[i - 1] + k;
            const swap = chars[left];
            chars[left] = chars[right];
            chars[right] = swap;
        }
    }
    return chars.join('');
}

export function decodePayload(encoded) {
    if (!encoded) return '';
    const payload = encoded.slice(1);
    const reordered = reverseSwaps(payload, swapPositions(payload));
    const chars = atob(reordered.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(chars, char => char.charCodeAt(0)));
}
