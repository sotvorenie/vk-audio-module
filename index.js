import { VK } from 'vk-io';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

import {token} from "./token.js";

ffmpeg.setFfmpegPath(ffmpegStatic)

const vk = new VK({token})

const WORK_DIR = path.join(process.cwd(), 'vk-hls-temp')
const SEGMENTS_DIR = path.join(WORK_DIR, 'segments')
const COMBINED_TS = path.join(WORK_DIR, 'combined.ts')
const COMBINED_RAW = path.join(WORK_DIR, 'combined.raw')
const OUTPUT_FILE = path.join(process.cwd(), 'downloads', 'audio', 'track.mp3')

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
const CONCURRENCY = 3;

const HTTP_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/131.0 Safari/537.36',

    'Accept': '*/*'
};

function sleep(ms) {
    return new Promise(resolve => {setTimeout(resolve, ms)});
}

const fetchBuffer = async (url, attempts = 5) => {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetch(url, {headers: HTTP_HEADERS, redirect: 'follow'});

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status} ${response.statusText}`
                );
            }

            const arrayBuffer = await response.arrayBuffer();

            const buffer = Buffer.from(arrayBuffer);

            if (!buffer.length) {
                throw new Error(
                    'Сервер вернул пустой ответ'
                );
            }

            return buffer;
        } catch (error) {
            lastError = error;

            console.log(`HTTP retry ${attempt}/${attempts}: ${url}`);

            if (attempt < attempts) await sleep(500 * attempt);
        }
    }

    throw new Error(
        `Не удалось скачать ${url}\n` +
        `${lastError?.message || lastError}`
    );
}

const fetchText = async (url) => {
    return (await fetchBuffer(url)).toString('utf8');
}

const parseAttributeList = (line) => {
    const result = {};

    const colonIndex = line.indexOf(':');

    if (colonIndex === -1) return result;

    const value = line.slice(colonIndex + 1);

    const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;

    let match;

    while ((match = regex.exec(value)) !== null) {
        let attributeValue = match[2];

        if (attributeValue.startsWith('"') && attributeValue.endsWith('"')) {
            attributeValue = attributeValue.slice(1, -1);
        }

        result[match[1]] = attributeValue;
    }

    return result;
}

const parsePlaylist = (text, playlistUrl) => {
    const lines = text.split(/\r?\n/).map(line => line.trim());

    let mediaSequence = 0;

    let currentKey = {
        method: 'NONE'
    };

    let currentDuration = null;

    const segments = [];

    for (const line of lines) {
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const value = line.slice('#EXT-X-MEDIA-SEQUENCE:'.length);

            mediaSequence = Number(value);

            if (!Number.isSafeInteger(mediaSequence)) {
                throw new Error(
                    `Некорректный MEDIA-SEQUENCE: ${value}`
                );
            }

            continue;
        }

        if (line.startsWith('#EXT-X-KEY:')) {
            const attrs = parseAttributeList(line);

            const method = attrs.METHOD;

            if (method === 'NONE') {
                currentKey = {
                    method: 'NONE'
                };

                continue;
            }

            if (method !== 'AES-128') {
                throw new Error(
                    `Неподдерживаемый HLS METHOD: ${method}`
                );
            }

            if (!attrs.URI) {
                throw new Error(
                    'AES-128 key без URI'
                );
            }

            const keyFormat = attrs.KEYFORMAT || 'identity';

            if (keyFormat !== 'identity') {
                throw new Error(
                    `Неподдерживаемый KEYFORMAT: ${keyFormat}`
                );
            }

            currentKey = {
                method: 'AES-128',
                uri: new URL(
                    attrs.URI,
                    playlistUrl
                ).href,
                iv: attrs.IV || null
            };

            continue;
        }

        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            throw new Error(
                'HLS использует EXT-X-BYTERANGE, ' +
                'этот вариант загрузчика его не поддерживает'
            );
        }

        if (line.startsWith('#EXT-X-MAP:')) {
            throw new Error(
                'HLS использует EXT-X-MAP, ' +
                'ожидается обычный MPEG-TS HLS'
            );
        }

        if (line.startsWith('#EXTINF:')) {
            const value = line.slice('#EXTINF:'.length).split(',')[0];

            currentDuration = Number(value);

            if (!Number.isFinite(currentDuration) || currentDuration <= 0) {
                throw new Error(
                    `Некорректный EXTINF: ${value}`
                );
            }

            continue;
        }

        if (line.startsWith('#')) continue;

        if (currentDuration === null) {
            throw new Error(
                `Найден сегмент без EXTINF: ${line}`
            );
        }

        const index = segments.length;

        const sequence = mediaSequence + index;

        segments.push({
            index,
            sequence,
            duration: currentDuration,
            url: new URL(
                line,
                playlistUrl
            ).href,
            key: {
                ...currentKey
            }
        });
        currentDuration = null;
    }

    if (!segments.length) {
        throw new Error(
            'В m3u8 не найдено ни одного сегмента'
        );
    }

    return segments;
}

const keyCache = new Map();

async function getHlsKey(url) {
    if (keyCache.has(url)) return keyCache.get(url);

    const key = await fetchBuffer(url);

    if (key.length !== 16) {
        throw new Error(
            `HLS AES-128 key должен быть 16 байт, ` +
            `получено ${key.length}`
        );
    }

    keyCache.set(url, key);

    return key;
}

function makeIv(segment) {
    if (segment.key.iv) {
        let hex = segment.key.iv;

        if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);

        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            throw new Error(
                `Некорректный IV: ${segment.key.iv}`
            );
        }

        hex = hex.padStart(32, '0');

        if (hex.length !== 32) {
            throw new Error(
                `IV должен быть ровно 16 байт: ` +
                `${segment.key.iv}`
            );
        }

        return Buffer.from(hex, 'hex');
    }

    const iv = Buffer.alloc(16);

    const sequence = BigInt(segment.sequence);

    iv.writeBigUInt64BE(sequence, 8);

    return iv;
}

const decryptSegment = async (encrypted, segment) => {
    if (segment.key.method === 'NONE') return encrypted;

    if (segment.key.method !== 'AES-128') {
        throw new Error(
            `Неизвестный HLS encryption method: ` +
            `${segment.key.method}`
        );
    }

    const key = await getHlsKey(segment.key.uri);

    const iv = makeIv(segment);

    if (encrypted.length % 16 !== 0) {
        throw new Error(
            `Сегмент #${segment.index} имеет ` +
            `некорректную длину AES ciphertext: ` +
            `${encrypted.length} байт`
        );
    }

    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);

        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
        throw new Error(
            `Не удалось расшифровать сегмент ` +
            `#${segment.index}: ` +
            `${error.message}`
        );
    }
}

const mapLimit = async (items, limit, worker) => {
    let nextIndex = 0;

    const workers = Math.min(limit, items.length);

    await Promise.all(
        Array.from(
            { length: workers },
            async () => {
                while (true) {
                    const index = nextIndex++;
                    if (index >= items.length) return;

                    await worker(items[index], index);
                }
            }
        )
    );
}

const downloadAndDecryptSegments = async (segments) => {
    await mapLimit(segments, CONCURRENCY, async segment => {
            const number = String(segment.index).padStart(4, '0');

            const tsFile = path.join(SEGMENTS_DIR, `${number}.ts`);

            const encrypted = await fetchBuffer(segment.url);

            const decrypted = await decryptSegment(encrypted, segment);

            await fsp.writeFile(tsFile, decrypted);
        }
    );
}

const concatTsSegments = async (segments, outputFile) => {
    await fsp.rm(outputFile, {force: true});

    let totalBytes = 0;

    for (const segment of segments) {
        const number = String(segment.index).padStart(4, '0');

        const tsFile = path.join(SEGMENTS_DIR, `${number}.ts`);

        const data = await fsp.readFile(tsFile);

        if (!data.length) {
            throw new Error(
                `Сегмент #${segment.index} пустой`
            );
        }

        await fsp.appendFile(outputFile, data);

        totalBytes += data.length;
    }

    if (!totalBytes) {
        throw new Error(
            'После объединения TS получился пустой файл'
        );
    }

    return totalBytes;
}

const convertCombinedTsToRawPcm = (tsFile, pcmFile) => {
    return new Promise(
        (resolve, reject) => {
            let stderr = '';

            ffmpeg(tsFile)
                .inputFormat('mpegts')
                .inputOptions([
                    '-fflags +genpts',
                    '-probesize 50M',
                    '-analyzeduration 50M',
                    '-dts_delta_threshold 0.5'
                ])
                .outputOptions([
                    '-map 0:a:0',
                    '-vn',
                    '-af asetpts=N/SR/TB',
                    '-c:a pcm_s16le',
                    '-ar 48000',
                    '-ac 2',
                    '-f s16le'
                ])
                .on(
                    'error',
                    error => {
                        reject(
                            new Error(
                                'FFmpeg не смог ' +
                                'декодировать объединённый TS\n\n' +
                                `${error.message}\n\n` +
                                stderr
                            )
                        );
                    }
                )
                .on(
                    'end',
                    resolve
                )
                .save(pcmFile);
        }
    );
}

const encodeRawPcmToMp3 = (rawFile, outputFile) => {
    return new Promise(
        (resolve, reject) => {
            ffmpeg(rawFile)
                .inputFormat('s16le')
                .inputOptions([
                    '-ar 48000',
                    '-ac 2'
                ])
                .outputOptions([
                    '-c:a libmp3lame',
                    '-b:a 320k',
                    '-ar 48000',
                    '-ac 2',
                    '-write_xing 1'
                ])
                .on(
                    'error',
                    reject
                )
                .on(
                    'end',
                    resolve
                )
                .save(outputFile);
        }
    );
}

const validatePcm = async (pcmFile, expectedDuration) => {
    const stat = await fsp.stat(pcmFile);

    if (!stat.size) {
        throw new Error(
            'FFmpeg создал пустой PCM'
        );
    }

    const duration = stat.size / BYTES_PER_SECOND;

    if (duration < expectedDuration * 0.95) {
        throw new Error(
            `Потеряно слишком много аудио: ` +
            `${duration.toFixed(3)}s ` +
            `вместо ${expectedDuration.toFixed(3)}s`
        );
    }

    if (duration > expectedDuration + 10) {
        throw new Error(
            `Получено подозрительно много аудио: ` +
            `${duration.toFixed(3)}s ` +
            `при ожидаемых ${expectedDuration.toFixed(3)}s`
        );
    }

    return duration;
}

const cleanup = async () => {
    await fsp.rm(WORK_DIR, {recursive: true, force: true});
}

const main = async () => {
    let success = false;

    try {
        await cleanup();

        await fsp.mkdir(SEGMENTS_DIR, {recursive: true});

        await fsp.mkdir(path.dirname(OUTPUT_FILE), {recursive: true});

        const response = await vk.api.audio.get({count: 1});

        const track = response.items?.[0];

        if (!track) {
            throw new Error(
                'VK не вернул ни одного трека'
            );
        }

        if (!track.url) {
            throw new Error(
                'У трека отсутствует URL'
            );
        }

        const playlistText = await fetchText(track.url);

        if (!playlistText.includes('#EXTM3U')) {
            throw new Error(
                'Ответ VK не похож на HLS playlist'
            );
        }

        const segments = parsePlaylist(playlistText, track.url);

        const expectedDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);

        await downloadAndDecryptSegments(segments);

        const combinedTsBytes = await concatTsSegments(segments, COMBINED_TS);

        await convertCombinedTsToRawPcm(COMBINED_TS, COMBINED_RAW);

        const pcmDuration = await validatePcm(COMBINED_RAW, expectedDuration);

        await fsp.rm(OUTPUT_FILE, {force: true});

        await encodeRawPcmToMp3(COMBINED_RAW, OUTPUT_FILE);

        const outputStat = await fsp.stat(OUTPUT_FILE);

        if (!outputStat.size) {
            throw new Error(
                'Финальный MP3 пустой'
            );
        }

        success = true;
    } catch (error) {
        console.error(error)
    } finally {
        if (success) {
            await cleanup();
        }
    }
}

main().then()