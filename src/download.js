import { openSync, writeSync, closeSync, mkdirSync } from "fs";
import { Socket } from "net";
import { resolve, dirname, sep } from "path";
import crypto from "crypto";
import { getPeers } from "./tracker.js";
import {
    buildHandshake,
    buildInterested,
    buildRequest,
    parse,
} from "./message.js";
import Pieces from "./pieces.js";
import Queue from "./queue.js";
import {
    infoHash,
    pieceLen,
    pieceHash,
    blocksPerPiece,
    blockLen,
    decodeStr,
    BLOCK_LEN,
} from "./torrent-parser.js";

const MAX_PIPELINE = 5; // outstanding requests per peer
const SOCKET_TIMEOUT = 60_000; // idle time before dropping a peer
const MAX_MSG_LEN = 1 << 20; // sanity limit for a single peer message
const TICK_INTERVAL = 5_000; // how often idle peers are nudged

export default (torrent, path) => {
    getPeers(torrent, (peers) => {
        console.log(`Got ${peers.length} peers`);

        const ctx = {
            torrent,
            path,
            hash: infoHash(torrent),
            pieces: new Pieces(torrent),
            files: openFiles(torrent, path),
            pieceBuffers: new Map(),
            peers: new Set(),
            verified: 0,
            finished: false,
        };

        ctx.ticker = setInterval(() => {
            ctx.peers.forEach((peer) => requestBlocks(ctx, peer));
        }, TICK_INTERVAL);

        peers.filter((p) => p.port > 0).forEach((p) => download(p, ctx));
    });
};

/* ---------- files ---------- */

function openFiles(torrent, basePath) {
    const root = resolve(basePath);

    if (torrent.info.files) {
        let offset = 0;
        return torrent.info.files.map((f) => {
            const parts = f.path.map(decodeStr);
            const filePath = resolve(root, ...parts);
            if (!filePath.startsWith(root + sep)) {
                throw new Error(`Unsafe path in torrent: ${parts.join("/")}`);
            }
            mkdirSync(dirname(filePath), { recursive: true });
            const entry = {
                fd: openSync(filePath, "w"),
                start: offset,
                length: f.length,
            };
            offset += f.length;
            return entry;
        });
    }

    return [{ fd: openSync(root, "w"), start: 0, length: torrent.info.length }];
}

// Writes a buffer located at `pieceOffset` in the torrent's byte stream,
// splitting it across files when needed.
function writePiece(files, pieceOffset, buf) {
    const end = pieceOffset + buf.length;
    for (const f of files) {
        const fileEnd = f.start + f.length;
        if (fileEnd <= pieceOffset || f.start >= end) continue;
        const from = Math.max(pieceOffset, f.start);
        const to = Math.min(end, fileEnd);
        writeSync(f.fd, buf, from - pieceOffset, to - from, from - f.start);
    }
}

function shutdown(ctx) {
    if (ctx.finished) return;
    ctx.finished = true;
    clearInterval(ctx.ticker);
    ctx.peers.forEach((peer) => peer.socket.destroy());
    ctx.files.forEach((f) => {
        try {
            closeSync(f.fd);
        } catch {}
    });
}

/* ---------- peer connection ---------- */

function download(addr, ctx) {
    const socket = new Socket();
    const peer = { socket, queue: new Queue(ctx.torrent) };
    ctx.peers.add(peer);

    socket.setTimeout(SOCKET_TIMEOUT);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => {}); // most peers are unreachable; 'close' follows
    socket.on("close", () => onPeerClose(ctx, peer));

    socket.connect(addr.port, addr.ip, () => {
        socket.write(buildHandshake(ctx.torrent));
    });

    onWholeMsg(socket, (msg, isHandshake) => {
        try {
            msgHandler(msg, isHandshake, ctx, peer);
        } catch {
            socket.destroy(); // malformed message from peer
        }
    });
}

function onPeerClose(ctx, peer) {
    releasePending(ctx, peer);
    ctx.peers.delete(peer);
    if (!ctx.finished && ctx.peers.size === 0) {
        console.error("\nAll peers disconnected before the download finished.");
        shutdown(ctx);
    }
}

function releasePending(ctx, peer) {
    for (const block of peer.queue.pending.values()) {
        ctx.pieces.cancelRequested(block);
    }
    peer.queue.pending.clear();
}

function onWholeMsg(socket, callback) {
    let saved = Buffer.alloc(0);
    let handshake = true;

    socket.on("data", (chunk) => {
        saved = Buffer.concat([saved, chunk]);

        while (saved.length >= 4) {
            const len = handshake
                ? saved.readUInt8(0) + 49
                : saved.readUInt32BE(0) + 4;

            if (len > MAX_MSG_LEN) {
                socket.destroy();
                return;
            }
            if (saved.length < len) break;

            const msg = saved.subarray(0, len);
            saved = saved.subarray(len);
            const isHandshake = handshake;
            handshake = false;

            callback(msg, isHandshake);
            if (socket.destroyed) return;
        }
    });
}

/* ---------- message handling ---------- */

function msgHandler(msg, isHandshake, ctx, peer) {
    const { socket } = peer;

    if (isHandshake) {
        if (!validHandshake(msg, ctx.hash)) {
            socket.destroy();
            return;
        }
        socket.write(buildInterested());
        return;
    }

    const m = parse(msg);
    if (m.id === 0) chokeHandler(ctx, peer);
    else if (m.id === 1) unchokeHandler(ctx, peer);
    else if (m.id === 4) haveHandler(ctx, peer, m.payload);
    else if (m.id === 5) bitfieldHandler(ctx, peer, m.payload);
    else if (m.id === 7) pieceHandler(ctx, peer, m.payload);
}

function validHandshake(msg, hash) {
    return (
        msg.length === 68 &&
        msg.readUInt8(0) === 19 &&
        msg.toString("utf8", 1, 20) === "BitTorrent protocol" &&
        msg.subarray(28, 48).equals(hash)
    );
}

function chokeHandler(ctx, peer) {
    peer.queue.choked = true;
    releasePending(ctx, peer); // peer drops our outstanding requests when it chokes us
}

function unchokeHandler(ctx, peer) {
    peer.queue.choked = false;
    requestBlocks(ctx, peer);
}

function haveHandler(ctx, peer, payload) {
    const pieceIndex = payload.readUInt32BE(0);
    if (pieceIndex >= ctx.pieces.count) return;
    peer.queue.addPeerPiece(pieceIndex);
    requestBlocks(ctx, peer);
}

function bitfieldHandler(ctx, peer, payload) {
    for (let i = 0; i < payload.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
            if (payload[i] & (0x80 >> bit)) {
                const pieceIndex = i * 8 + bit;
                if (pieceIndex < ctx.pieces.count)
                    peer.queue.addPeerPiece(pieceIndex);
            }
        }
    }
    requestBlocks(ctx, peer);
}

function pieceHandler(ctx, peer, block) {
    if (ctx.finished) return;
    const { torrent, pieces } = ctx;
    const { index, begin } = block;

    peer.queue.pending.delete(`${index}:${begin}`);

    // Validate what the peer sent
    if (
        index < 0 ||
        index >= pieces.count ||
        begin < 0 ||
        begin % BLOCK_LEN !== 0
    )
        return;
    const blockIndex = begin / BLOCK_LEN;
    if (
        blockIndex >= blocksPerPiece(torrent, index) ||
        block.block.length !== blockLen(torrent, index, blockIndex)
    ) {
        return;
    }

    if (!pieces.hasBlock(block)) {
        let buf = ctx.pieceBuffers.get(index);
        if (!buf) {
            buf = Buffer.alloc(pieceLen(torrent, index));
            ctx.pieceBuffers.set(index, buf);
        }
        block.block.copy(buf, begin);
        pieces.addReceived(block);

        if (pieces.isPieceComplete(index)) completePiece(ctx, peer, index, buf);
        pieces.printPercentDone();
    }

    if (!ctx.finished) requestBlocks(ctx, peer);
}

function completePiece(ctx, peer, index, buf) {
    const { torrent, pieces } = ctx;
    ctx.pieceBuffers.delete(index);

    const actual = crypto.createHash("sha1").update(buf).digest();
    if (!actual.equals(pieceHash(torrent, index))) {
        console.error(`\nPiece ${index} failed hash check, retrying`);
        pieces.resetPiece(index);
        peer.queue.queue(index);
        return;
    }

    writePiece(ctx.files, index * torrent.info["piece length"], buf);
    ctx.verified++;

    if (ctx.verified === pieces.count) {
        console.log("\nDONE!");
        shutdown(ctx);
    }
}

function requestBlocks(ctx, peer) {
    const { socket, queue } = peer;
    if (ctx.finished || queue.choked || socket.destroyed) return;

    if (queue.length() === 0 && queue.pending.size === 0) {
        queue.refill(ctx.pieces);
    }

    while (queue.pending.size < MAX_PIPELINE && queue.length() > 0) {
        const block = queue.deque();
        if (!ctx.pieces.needed(block)) continue;

        socket.write(buildRequest(block));
        ctx.pieces.addRequested(block);
        queue.pending.set(`${block.index}:${block.begin}`, block);
    }
}
