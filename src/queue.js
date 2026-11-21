import { blocksPerPiece, blockLen, BLOCK_LEN } from "./torrent-parser.js";

export default class Queue {
    constructor(torrent) {
        this._torrent = torrent;
        this._queue = [];
        this._peerPieces = new Set(); // pieces this peer has
        this.choked = true;
        this.pending = new Map(); // "index:begin" -> block (requested, not yet received)
    }

    queue(pieceIndex) {
        const nBlocks = blocksPerPiece(this._torrent, pieceIndex);
        for (let i = 0; i < nBlocks; i++) {
            this._queue.push({
                index: pieceIndex,
                begin: i * BLOCK_LEN,
                length: blockLen(this._torrent, pieceIndex, i),
            });
        }
    }

    addPeerPiece(pieceIndex) {
        if (this._peerPieces.has(pieceIndex)) return;
        this._peerPieces.add(pieceIndex);
        this.queue(pieceIndex);
    }

    // Re-queue every incomplete piece this peer has (recovers blocks lost to dropped peers)
    refill(pieces) {
        for (const index of this._peerPieces) {
            if (!pieces.isPieceComplete(index)) this.queue(index);
        }
    }

    deque() {
        return this._queue.shift();
    }

    peek() {
        return this._queue[0];
    }

    length() {
        return this._queue.length;
    }
}
