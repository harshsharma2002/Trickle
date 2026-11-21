import dgram from "dgram";
import { URL } from "url";
import crypto from "crypto";
import bencode from "bencode";
import { infoHash, size, decodeStr } from "./torrent-parser.js";
import { genId } from "./util.js";

const TRACKER_TIMEOUT = 10_000;
const LISTEN_PORT = 6881;
const SUPPORTED = new Set(["udp:", "http:", "https:"]);

/* ---------- public API ---------- */

export const getPeers = async (torrent, callback) => {
    const trackers = getTrackers(torrent);
    if (trackers.length === 0) {
        console.error(
            "No supported trackers (udp/http/https) in this torrent.",
        );
        return;
    }

    // Query every tracker concurrently; each is capped by TRACKER_TIMEOUT
    const results = await Promise.all(
        trackers.map(async (url) => {
            try {
                const peers =
                    url.protocol === "udp:"
                        ? await queryUdp(torrent, url)
                        : await queryHttp(torrent, url);
                console.log(`  ${url.href} -> ${peers.length} peers`);
                return peers;
            } catch (err) {
                console.error(`  ${url.href} failed: ${err.message}`);
                return [];
            }
        }),
    );

    // Merge and de-duplicate
    const unique = new Map();
    for (const p of results.flat()) unique.set(`${p.ip}:${p.port}`, p);

    if (unique.size === 0) {
        console.error("No tracker returned any peers.");
        return;
    }
    callback([...unique.values()]);
};

// announce + announce-list, de-duplicated, supported protocols only
function getTrackers(torrent) {
    const raw = [];
    if (torrent.announce) raw.push(decodeStr(torrent.announce));
    for (const tier of torrent["announce-list"] ?? []) {
        for (const u of tier) raw.push(decodeStr(u));
    }
    return [...new Set(raw)].flatMap((u) => {
        try {
            const url = new URL(u);
            return SUPPORTED.has(url.protocol) ? [url] : [];
        } catch {
            return [];
        }
    });
}

/* ---------- HTTP / HTTPS tracker ---------- */

// Percent-encode raw bytes (URLSearchParams can't do this safely)
const encodeBytes = (buf) =>
    Array.from(buf, (b) => "%" + b.toString(16).padStart(2, "0")).join("");

async function queryHttp(torrent, url) {
    const left = size(torrent).readBigUInt64BE(0).toString();

    const query = [
        `info_hash=${encodeBytes(infoHash(torrent))}`,
        `peer_id=${encodeBytes(genId())}`,
        `port=${LISTEN_PORT}`,
        `uploaded=0`,
        `downloaded=0`,
        `left=${left}`,
        `compact=1`,
        `numwant=200`,
        `event=started`,
    ].join("&");

    // Keep any existing query (e.g. ?passkey=...) on the announce URL
    const separator = url.search ? "&" : "?";
    const fullUrl = `${url.origin}${url.pathname}${url.search}${separator}${query}`;

    const res = await fetch(fullUrl, {
        signal: AbortSignal.timeout(TRACKER_TIMEOUT),
        headers: { "User-Agent": "torrent-client-edu/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = Buffer.from(await res.arrayBuffer());
    let data;
    try {
        data = bencode.decode(body);
    } catch {
        throw new Error("response is not valid bencode");
    }

    if (data["failure reason"]) {
        throw new Error(`tracker error: ${decodeStr(data["failure reason"])}`);
    }

    return [...parseHttpPeers(data.peers), ...parseCompactPeers6(data.peers6)];
}

function parseHttpPeers(peers) {
    if (!peers) return [];

    // Non-compact form: list of { ip, port, "peer id" }
    if (Array.isArray(peers)) {
        return peers
            .filter((p) => p.ip && p.port)
            .map((p) => ({ ip: decodeStr(p.ip), port: Number(p.port) }));
    }

    // Compact form: 6 bytes per peer
    const buf = Buffer.from(peers);
    const out = [];
    for (let i = 0; i + 6 <= buf.length; i += 6) {
        out.push({
            ip: buf.subarray(i, i + 4).join("."),
            port: buf.readUInt16BE(i + 4),
        });
    }
    return out;
}

// BEP 7: 18 bytes per peer (16-byte address + 2-byte port)
function parseCompactPeers6(peers6) {
    if (!peers6 || Array.isArray(peers6)) return [];
    const buf = Buffer.from(peers6);
    const out = [];
    for (let i = 0; i + 18 <= buf.length; i += 18) {
        const groups = [];
        for (let g = 0; g < 8; g++)
            groups.push(buf.readUInt16BE(i + g * 2).toString(16));
        out.push({ ip: groups.join(":"), port: buf.readUInt16BE(i + 16) });
    }
    return out;
}

/* ---------- UDP tracker (BEP 15) ---------- */

function queryUdp(torrent, url) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        const connReq = buildConnReq();
        const connTx = connReq.subarray(12, 16);
        let announceTx = null;
        let state = "connect";
        let settled = false;

        const finish = (err, peers) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            err ? reject(err) : resolve(peers);
        };

        const send = (message) => {
            try {
                socket.send(
                    message,
                    0,
                    message.length,
                    Number(url.port),
                    url.hostname,
                    (err) => err && finish(err),
                );
            } catch (err) {
                finish(err);
            }
        };

        const timer = setTimeout(
            () => finish(new Error("timed out")),
            TRACKER_TIMEOUT,
        );
        socket.on("error", finish);

        socket.on("message", (resp) => {
            if (resp.length < 8) return;
            const action = resp.readUInt32BE(0);
            const tx = resp.subarray(4, 8);

            if (action === 3) {
                finish(
                    new Error(`tracker error: ${resp.subarray(8).toString()}`),
                );
            } else if (
                state === "connect" &&
                action === 0 &&
                resp.length >= 16 &&
                tx.equals(connTx)
            ) {
                state = "announce";
                const req = buildAnnounceReq(resp.subarray(8, 16), torrent);
                announceTx = req.subarray(12, 16);
                send(req);
            } else if (
                state === "announce" &&
                action === 1 &&
                resp.length >= 20 &&
                tx.equals(announceTx)
            ) {
                finish(null, parseUdpPeers(resp));
            }
        });

        send(connReq);
    });
}

function buildConnReq() {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(0x417, 0); // connection id (magic constant)
    buf.writeUInt32BE(0x27101980, 4);
    buf.writeUInt32BE(0, 8); // action: connect
    crypto.randomBytes(4).copy(buf, 12); // transaction id
    return buf;
}

function buildAnnounceReq(connId, torrent, port = LISTEN_PORT) {
    const buf = Buffer.alloc(98);
    connId.copy(buf, 0); // connection id
    buf.writeUInt32BE(1, 8); // action: announce
    crypto.randomBytes(4).copy(buf, 12); // transaction id
    infoHash(torrent).copy(buf, 16); // info hash
    genId().copy(buf, 36); // peer id
    // downloaded (56) = 0
    size(torrent).copy(buf, 64); // left
    // uploaded (72) = 0
    buf.writeUInt32BE(0, 80); // event: none
    buf.writeUInt32BE(0, 84); // ip: default
    crypto.randomBytes(4).copy(buf, 88); // key
    buf.writeInt32BE(-1, 92); // num_want: default
    buf.writeUInt16BE(port, 96); // port
    return buf;
}

function parseUdpPeers(resp) {
    const peers = [];
    for (let i = 20; i + 6 <= resp.length; i += 6) {
        peers.push({
            ip: resp.subarray(i, i + 4).join("."),
            port: resp.readUInt16BE(i + 4),
        });
    }
    return peers;
}
