import { infoHash } from "./torrent-parser.js";
import { genId } from "./util.js";

export function buildHandshake(torrent) {
    const buf = Buffer.alloc(68);
    buf.writeUInt8(19, 0); // pstrlen
    buf.write("BitTorrent protocol", 1); // pstr
    // reserved bytes 20..27 stay zero
    infoHash(torrent).copy(buf, 28); // info hash
    genId().copy(buf, 48); // peer id
    return buf;
}

export function buildKeepAlive() {
    return Buffer.alloc(4);
}

const buildSimple = (id) => {
    const buf = Buffer.alloc(5);
    buf.writeUInt32BE(1, 0);
    buf.writeUInt8(id, 4);
    return buf;
};

export const buildChoke = () => buildSimple(0);
export const buildUnchoke = () => buildSimple(1);
export const buildInterested = () => buildSimple(2);
export const buildUninterested = () => buildSimple(3);

export function buildHave(pieceIndex) {
    const buf = Buffer.alloc(9);
    buf.writeUInt32BE(5, 0);
    buf.writeUInt8(4, 4);
    buf.writeUInt32BE(pieceIndex, 5);
    return buf;
}

export function buildBitfield(bitfield) {
    const buf = Buffer.alloc(bitfield.length + 5);
    buf.writeUInt32BE(bitfield.length + 1, 0);
    buf.writeUInt8(5, 4);
    bitfield.copy(buf, 5);
    return buf;
}

function buildBlockRef(id, payload) {
    const buf = Buffer.alloc(17);
    buf.writeUInt32BE(13, 0);
    buf.writeUInt8(id, 4);
    buf.writeUInt32BE(payload.index, 5);
    buf.writeUInt32BE(payload.begin, 9);
    buf.writeUInt32BE(payload.length, 13);
    return buf;
}

export const buildRequest = (payload) => buildBlockRef(6, payload);
export const buildCancel = (payload) => buildBlockRef(8, payload);

export function buildPiece(payload) {
    const buf = Buffer.alloc(payload.block.length + 13);
    buf.writeUInt32BE(payload.block.length + 9, 0);
    buf.writeUInt8(7, 4);
    buf.writeUInt32BE(payload.index, 5);
    buf.writeUInt32BE(payload.begin, 9);
    payload.block.copy(buf, 13);
    return buf;
}

export function buildPort(port) {
    const buf = Buffer.alloc(7);
    buf.writeUInt32BE(3, 0);
    buf.writeUInt8(9, 4);
    buf.writeUInt16BE(port, 5);
    return buf;
}

export function parse(msg) {
    const id = msg.length > 4 ? msg.readInt8(4) : null;
    let payload = msg.length > 5 ? msg.subarray(5) : null;

    if (id === 6 || id === 7 || id === 8) {
        if (!payload || payload.length < 8)
            throw new Error("malformed message");
        const index = payload.readInt32BE(0);
        const begin = payload.readInt32BE(4);
        const rest = payload.subarray(8);
        if (id === 7) {
            payload = { index, begin, block: rest };
        } else {
            if (rest.length < 4) throw new Error("malformed message");
            payload = { index, begin, length: rest.readInt32BE(0) };
        }
    }

    return {
        size: msg.readInt32BE(0),
        id,
        payload,
    };
}
