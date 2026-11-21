import { blocksPerPiece, BLOCK_LEN } from "./torrent-parser.js";

export default class Pieces {
    constructor(torrent) {
        const nPieces = torrent.info.pieces.length / 20;
        const build = () =>
            Array.from({ length: nPieces }, (_, i) =>
                new Array(blocksPerPiece(torrent, i)).fill(false),
            );

        this._requested = build();
        this._received = build();
        this._total = this._received.reduce(
            (n, blocks) => n + blocks.length,
            0,
        );
        this._requestedCount = 0;
        this._receivedCount = 0;
    }

    get count() {
        return this._received.length;
    }

    addRequested(pieceBlock) {
        const row = this._requested[pieceBlock.index];
        const b = pieceBlock.begin / BLOCK_LEN;
        if (!row[b]) {
            row[b] = true;
            this._requestedCount++;
        }
    }

    // Called when a peer disconnects/chokes before delivering a block
    cancelRequested(pieceBlock) {
        const b = pieceBlock.begin / BLOCK_LEN;
        if (
            this._requested[pieceBlock.index][b] &&
            !this._received[pieceBlock.index][b]
        ) {
            this._requested[pieceBlock.index][b] = false;
            this._requestedCount--;
        }
    }

    addReceived(pieceBlock) {
        const b = pieceBlock.begin / BLOCK_LEN;
        if (!this._received[pieceBlock.index][b]) {
            this._received[pieceBlock.index][b] = true;
            this._receivedCount++;
        }
        this.addRequested(pieceBlock);
    }

    hasBlock(pieceBlock) {
        return this._received[pieceBlock.index][pieceBlock.begin / BLOCK_LEN];
    }

    needed(pieceBlock) {
        // Everything has been requested at least once: allow re-requesting
        // blocks that haven't arrived yet (end-game behaviour)
        if (this._requestedCount === this._total) {
            this._requested = this._received.map((blocks) => blocks.slice());
            this._requestedCount = this._receivedCount;
        }
        const row = this._requested[pieceBlock.index];
        if (!row) return false;
        return !row[pieceBlock.begin / BLOCK_LEN];
    }

    isPieceComplete(pieceIndex) {
        return this._received[pieceIndex].every(Boolean);
    }

    // Used when a completed piece fails its hash check
    resetPiece(pieceIndex) {
        const rec = this._received[pieceIndex];
        const req = this._requested[pieceIndex];
        for (let b = 0; b < rec.length; b++) {
            if (rec[b]) this._receivedCount--;
            if (req[b]) this._requestedCount--;
            rec[b] = false;
            req[b] = false;
        }
    }

    printPercentDone() {
        const percent = Math.floor((this._receivedCount / this._total) * 100);
        process.stdout.write(`progress: ${percent}%\r`);
    }
}
