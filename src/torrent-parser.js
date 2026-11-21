import { readFileSync } from "fs";
import crypto from "crypto";
import bencode from "bencode";

export const BLOCK_LEN = 2 ** 14;

// bencode v4 returns byte strings as Uint8Array, so decode them explicitly
export const decodeStr = (bytes) => Buffer.from(bytes).toString("utf8");

export const open = (filepath) => bencode.decode(readFileSync(filepath));

const hashCache = new WeakMap();
export const infoHash = (torrent) => {
    if (!hashCache.has(torrent)) {
        const info = bencode.encode(torrent.info);
        hashCache.set(torrent, crypto.createHash("sha1").update(info).digest());
    }
    return hashCache.get(torrent);
};

const totalCache = new WeakMap();
const totalSize = (torrent) => {
    if (!totalCache.has(torrent)) {
        const total = torrent.info.files
            ? torrent.info.files.reduce((sum, f) => sum + BigInt(f.length), 0n)
            : BigInt(torrent.info.length);
        totalCache.set(torrent, total);
    }
    return totalCache.get(torrent);
};

// 8-byte big-endian buffer (used for the "left" field in the announce request)
export const size = (torrent) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(totalSize(torrent));
    return buf;
};

export const numPieces = (torrent) => torrent.info.pieces.length / 20;

export const pieceHash = (torrent, pieceIndex) =>
    Buffer.from(
        torrent.info.pieces.subarray(pieceIndex * 20, pieceIndex * 20 + 20),
    );

export const pieceLen = (torrent, pieceIndex) => {
    const totalLength = Number(totalSize(torrent));
    const pieceLength = torrent.info["piece length"];
    const lastPieceLength = totalLength % pieceLength;
    const lastPieceIndex = Math.floor(totalLength / pieceLength);
    return lastPieceIndex === pieceIndex ? lastPieceLength : pieceLength;
};

export const blocksPerPiece = (torrent, pieceIndex) =>
    Math.ceil(pieceLen(torrent, pieceIndex) / BLOCK_LEN);

export const blockLen = (torrent, pieceIndex, blockIndex) => {
    const pieceLength = pieceLen(torrent, pieceIndex);
    const lastBlockLength = pieceLength % BLOCK_LEN;
    const lastBlockIndex = Math.floor(pieceLength / BLOCK_LEN);
    return blockIndex === lastBlockIndex ? lastBlockLength : BLOCK_LEN;
};
